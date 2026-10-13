import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { SyncAppModule } from './sync-app.module';
import { RabbitmqService, LK_RETRY_COUNT_HEADER, LK_ORIGINAL_ROUTING_KEY_HEADER } from '../rabbitmq/rabbitmq.module';
import { PrismaService } from '../prisma/prisma.service';

// Load root .env explicitly (do not rely on cwd).
dotenvConfig({ path: join(__dirname, '..', '..', '..', '..', '.env') });

const EVENT_TO_ROUTING: Record<string, string> = {
  'employee.upserted': 'lk.reference.employee.upserted.v1',
  'position.upserted': 'lk.reference.position.upserted.v1',
  'department.upserted': 'lk.reference.department.upserted.v1',
};

function parseArgs(argv: string[]): { dryRun: boolean; limit: number; from: string } {
  let dryRun = true;
  let limit = 100;
  let from = 'dlq';
  for (const a of argv) {
    if (a === '--apply') dryRun = false;
    else if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--limit=')) limit = Math.max(1, Math.min(1000, Number(a.slice(8)) || 100));
    else if (a.startsWith('--from=')) from = a.slice(7);
  }
  if (from !== 'dlq' && from !== 'retry') throw new Error(`--from must be dlq|retry (got ${from})`);
  return { dryRun, limit, from };
}

/**
 * Managed DLQ/old-retry recovery (never automatic).
 * - Inspects `edo.lk-reference-sync.dlq` (or `.retry`) via basicGet (no consumer disruption).
 * - Validates envelope (eventId/eventType), infers the correct routing key from
 *   eventType for old retry-format messages (queue-name key, no header).
 * - Skips already-processed eventIds (idempotent inbox check).
 * - dry-run (default) only reports; --apply republishes to the main queue via
 *   the default exchange with validated x-original-routing-key + reset retry
 *   count, preserving eventId/properties. Original DLQ message is acked only
 *   after the confirmed republish (operator must still verify consumer applied it).
 * - Limited by --limit (default 100, max 1000). No mass replay, no queue deletion.
 */
async function main() {
  const { dryRun, limit, from } = parseArgs(process.argv.slice(2));
  process.env.LK_EVENTS_CONSUME = '0';
  const app = await NestFactory.createApplicationContext(SyncAppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const rabbit = app.get(RabbitmqService);
    const prisma = app.get(PrismaService);
    await rabbit.assertTopologyOnly();
    const sourceQueue = from === 'dlq' ? rabbit.dlq : rabbit.retryQueue;
    // eslint-disable-next-line no-console
    console.log(`LK recover: inspecting ${sourceQueue} (dryRun=${dryRun} limit=${limit})`);
    const results: Array<{ eventId: string; eventType: string; action: string }> = [];
    // Use raw amqplib via RabbitmqService internals? Expose a minimal get path here
    // via direct connect (read-only + controlled ack on --apply only).
    const amqp = await import('amqplib');
    const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
    const conn = await amqp.connect(url);
    try {
      const ch = await conn.createConfirmChannel();
      try {
        for (let i = 0; i < limit; i++) {
          const msg = await ch.get(sourceQueue, { noAck: false });
          if (!msg) break;
          let action = 'skip';
          try {
            const json = JSON.parse(msg.content.toString('utf8')) as { eventId?: unknown; eventType?: unknown };
            const eventId = typeof json.eventId === 'string' ? json.eventId : null;
            const eventType = typeof json.eventType === 'string' ? json.eventType : null;
            if (!eventId || !eventType) {
              action = 'poison-no-eventId (left in place)';
              ch.nack(msg, false, true);
              results.push({ eventId: eventId ?? '<none>', eventType: eventType ?? '<none>', action });
              continue;
            }
            const already = await prisma.lkProcessedEvent.findUnique({ where: { eventId } }).catch(() => null);
            if (already) {
              action = 'already-processed (ack to drop duplicate)';
              if (!dryRun) ch.ack(msg);
              else ch.nack(msg, false, true);
              results.push({ eventId, eventType, action });
              continue;
            }
            const routingKey = EVENT_TO_ROUTING[eventType];
            if (!routingKey) {
              action = `unknown-eventType (left in place)`;
              ch.nack(msg, false, true);
              results.push({ eventId, eventType, action });
              continue;
            }
            if (dryRun) {
              action = `would-republish as ${routingKey} (dry-run, left in place)`;
              ch.nack(msg, false, true);
            } else {
              const headers = {
                ...((msg.properties.headers ?? {}) as Record<string, unknown>),
                [LK_RETRY_COUNT_HEADER]: 0,
                [LK_ORIGINAL_ROUTING_KEY_HEADER]: routingKey,
              };
              ch.sendToQueue(rabbit.queue, msg.content, {
                persistent: true,
                contentType: 'application/json',
                headers,
              });
              await ch.waitForConfirms();
              ch.ack(msg);
              action = `republished as ${routingKey} + acked`;
            }
            results.push({ eventId, eventType, action });
          } catch (err) {
            // Unparseable: leave in place for operator triage, never drop silently.
            try {
              ch.nack(msg as never, false, true);
            } catch {
              // ignore
            }
            results.push({ eventId: '<unparseable>', eventType: '<unparseable>', action: `error: ${(err as Error).message.slice(0, 120)} (left in place)` });
          }
        }
      } finally {
        await ch.close().catch(() => undefined);
      }
    } finally {
      await conn.close().catch(() => undefined);
    }
    // eslint-disable-next-line no-console
    console.log(`LK recover done: inspected ${results.length} message(s)`);
    for (const r of results.slice(0, 20)) {
      // eslint-disable-next-line no-console
      console.log(` - eventId=${r.eventId} type=${r.eventType} -> ${r.action}`);
    }
    if (results.length > 20) {
      // eslint-disable-next-line no-console
      console.log(` ... and ${results.length - 20} more (see DB/RabbitMQ UI for full backlog)`);
    }
    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log('Dry-run only: no messages moved. Re-run with --apply to republish inspected recoverable messages.');
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

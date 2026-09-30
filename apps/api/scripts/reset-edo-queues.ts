import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

// Load root .env explicitly when present (local dev); process env wins.
dotenvConfig({ path: join(__dirname, '..', '..', '..', '.env') });

const CONFIRM_VALUE = 'I_UNDERSTAND_QUEUED_EVENTS_WILL_BE_LOST';

/**
 * Operator/dev recovery for EDO-owned RabbitMQ queues ONLY.
 *
 * When the shared broker already has `edo.lk-reference-sync` with incompatible
 * arguments (e.g. created before the retry topology existed), the broker
 * answers 406 PRECONDITION_FAILED and the application must NOT delete anything
 * automatically on startup. This explicit command deletes and lets the next
 * `lk:topology` (or consumer boot) re-assert the correct topology.
 *
 * SAFETY:
 * - every deleted queue MUST belong to EDO (prefix guard);
 * - LK exchanges/queues are never touched (lk.events is only checked);
 * - requires CONFIRM_EDO_QUEUE_RESET=I_UNDERSTAND_QUEUED_EVENTS_WILL_BE_LOST;
 * - queued (not yet applied) events are LOST — run only deliberately.
 */
async function main() {
  if (process.env.CONFIRM_EDO_QUEUE_RESET !== CONFIRM_VALUE) {
    // eslint-disable-next-line no-console
    console.error(
      `Refusing to delete queues without explicit confirmation.\n` +
        `Re-run with CONFIRM_EDO_QUEUE_RESET=${CONFIRM_VALUE} if you accept that ` +
        `queued (not yet applied) LK events will be LOST.`,
    );
    process.exit(2);
  }
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error('RABBITMQ_URL is not set (refusing to run)');
    process.exit(1);
  }
  const base = process.env.EDO_LK_QUEUE ?? 'edo.lk-reference-sync';
  const targets = [base, `${base}.retry`];
  for (const name of targets) {
    if (!name.startsWith('edo.')) {
      // eslint-disable-next-line no-console
      console.error(`Refusing to delete non-EDO queue '${name}'`);
      process.exit(1);
    }
  }
  const amqp = await import('amqplib');
  const conn = await amqp.connect(url);
  try {
    const ch = await conn.createChannel();
    try {
      // Never touch the LK-owned exchange beyond a passive existence check.
      await ch.checkExchange(process.env.LK_EVENTS_EXCHANGE ?? 'lk.events');
      for (const name of targets) {
        try {
          await ch.deleteQueue(name);
          // eslint-disable-next-line no-console
          console.log(`Deleted EDO-owned queue '${name}' (re-assert via lk:topology)`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log(`Queue '${name}': ${(err as Error).message.slice(0, 160)}`);
        }
      }
    } finally {
      await ch.close().catch(() => undefined);
    }
  } finally {
    await conn.close().catch(() => undefined);
  }
}

void main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error((e as Error).message.slice(0, 300));
  process.exit(1);
});

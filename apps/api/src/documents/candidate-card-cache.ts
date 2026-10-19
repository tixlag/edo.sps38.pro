import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.module";
import type { CandidateSnapshotDto } from "./dto/document.dto";
import { normalizeErpCandidate } from "./erp-candidate.client";

export interface CandidateCardEntry {
  snapshot: CandidateSnapshotDto;
  freshUntil: number;
}
const namespace = "edo:candidate-cards:v1";
// Lua keeps the shared cache bounded and rejects writes from an expired owner.
const readScript = `local value = redis.call('HGET', KEYS[1], ARGV[1]); if value then redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1]) end; return value`;
const writeScript = `
if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1])
else
 redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]); redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
 local count = redis.call('ZCARD', KEYS[2]); if count > 1000 then
  local oldest = redis.call('ZRANGE', KEYS[2], 0, count - 1001)
  for _, key in ipairs(oldest) do redis.call('HDEL', KEYS[1], key); redis.call('ZREM', KEYS[2], key) end
 end
end
return 1`;

@Injectable()
export class CandidateCardCache {
  constructor(private readonly redis: RedisService) {}
  private async bounded<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("CACHE_TIMEOUT")), 1000);
        abort = () => reject(signal?.reason ?? new Error("CACHE_CANCELLED"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        // A late Redis reply is observed but can never keep the request open.
        operation.then(resolve, reject);
      });
    } finally {
      clearTimeout(timeout);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  private lock(uuid: string) {
    return `${namespace}:lock:${uuid}`;
  }
  async get(
    uuid: string,
    signal?: AbortSignal,
  ): Promise<CandidateCardEntry | null> {
    const raw = await this.bounded(
      this.redis.evalStrict(
        readScript,
        [namespace, `${namespace}:lru`],
        [uuid, String(Date.now())],
      ),
      signal,
    );
    if (raw === null) return null;
    const entry = JSON.parse(String(raw)) as CandidateCardEntry;
    if (!Number.isFinite(entry.freshUntil))
      throw new Error("Invalid cached candidate");
    return {
      snapshot: normalizeErpCandidate(entry.snapshot, uuid),
      freshUntil: entry.freshUntil,
    };
  }
  acquire(uuid: string, owner: string, signal?: AbortSignal) {
    return this.bounded(
      this.redis.setNxPxStrict(this.lock(uuid), owner, 20_000),
      signal,
    );
  }
  async write(
    uuid: string,
    owner: string,
    entry: CandidateCardEntry | null,
    signal?: AbortSignal,
  ) {
    const result = await this.bounded(
      this.redis.evalStrict(
        writeScript,
        [namespace, `${namespace}:lru`, this.lock(uuid)],
        [uuid, owner, entry ? JSON.stringify(entry) : "", String(Date.now())],
      ),
      signal,
    );
    if (result !== 1) throw new Error("Candidate cache lease lost");
  }
  async release(uuid: string, owner: string) {
    await this.bounded(this.redis.compareAndDelStrict(this.lock(uuid), owner));
  }
}

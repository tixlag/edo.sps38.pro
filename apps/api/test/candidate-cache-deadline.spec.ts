import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateCardCache } from "../src/documents/candidate-card-cache";
const uuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
afterEach(() => vi.useRealTimers());
describe("candidate cache command deadlines", () => {
  it.each(["read", "acquire", "write", "release"])(
    "bounds a connected but silent Redis %s",
    async (operation) => {
      vi.useFakeTimers();
      const silent = () => new Promise<never>(() => {});
      const cache = new CandidateCardCache({
        evalStrict: silent,
        setNxPxStrict: silent,
        compareAndDelStrict: silent,
      } as never);
      const pending =
        operation === "read"
          ? cache.get(uuid)
          : operation === "acquire"
            ? cache.acquire(uuid, "owner")
            : operation === "write"
              ? cache.write(uuid, "owner", null)
              : cache.release(uuid, "owner");
      const result = expect(pending).rejects.toThrow("CACHE_TIMEOUT");
      await vi.advanceTimersByTimeAsync(1200);
      await result;
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import { syncArrivalFacts } from "../src/documents/ig-arrival-facts-worker";

const lease = { lockToken: "test", generation: 1n };
const api = (pages: unknown[]) => ({
  arrivalFactsPage: vi.fn().mockImplementation(async () => pages.shift()),
});
const projection = () => ({
  apply: vi.fn(),
  finish: vi.fn(),
  recordIssue: vi.fn(),
});

describe("factual arrival sync", () => {
  it("rejects v1 before applying or finishing", async () => {
    const target = projection();
    await expect(
      syncArrivalFacts(
        api([{ items: [], nextCursor: null }]) as never,
        target as never,
        lease,
        Date.now() + 10000,
      ),
    ).rejects.toThrow();
    expect(target.apply).not.toHaveBeenCalled();
    expect(target.finish).not.toHaveBeenCalled();
  });
  it("does not finish a partial or malformed pass", async () => {
    const target = projection();
    await syncArrivalFacts(
      api([
        { contractVersion: 2, items: [], nextCursor: "next", issues: [] },
        { contractVersion: 2, items: [{}], nextCursor: null, issues: [] },
      ]) as never,
      target as never,
      lease,
      Date.now() + 10000,
    );
    expect(target.finish).not.toHaveBeenCalled();
  });
  it("does not finish when the source reports a missing person", async () => {
    const target = projection();
    await syncArrivalFacts(
      api([
        {
          contractVersion: 2,
          items: [],
          nextCursor: null,
          issues: [{ personUid: null, code: "INVALID_PERSON_IDENTITY" }],
        },
      ]) as never,
      target as never,
      lease,
      Date.now() + 10000,
    );
    expect(target.finish).not.toHaveBeenCalled();
  });
  it("rejects an ungrounded duplicate issue without finalizing", async () => {
    const target = projection();
    await syncArrivalFacts(
      api([
        {
          contractVersion: 2,
          items: [],
          nextCursor: null,
          issues: [{ personUid: null, code: "DUPLICATE_ARRIVAL_MEMBER_UID" }],
        },
      ]) as never,
      target as never,
      lease,
      Date.now() + 10000,
    );
    expect(target.finish).not.toHaveBeenCalled();
  });
  it("continues to a valid person after a malformed item but never finalizes that pass", async () => {
    const target = projection();
    const personUid = "00000000-0000-4000-8000-000000000001";
    await syncArrivalFacts(
      api([
        { contractVersion: 2, items: [{}], nextCursor: "next", issues: [] },
        {
          contractVersion: 2,
          items: [{ personUid, code1c: null, participations: [] }],
          nextCursor: null,
          issues: [],
        },
      ]) as never,
      target as never,
      lease,
      Date.now() + 10000,
    );
    expect(target.apply).toHaveBeenCalledOnce();
    expect(target.recordIssue).toHaveBeenCalled();
    expect(target.finish).not.toHaveBeenCalled();
  });
  it("resumes after a saved page without treating the continuation as a complete new scan", async () => {
    const target = projection(),
      checkpoint = vi.fn();
    const source = {
      arrivalFactsPage: vi
        .fn()
        .mockResolvedValueOnce({
          contractVersion: 2,
          items: [],
          nextCursor: "next",
          issues: [],
        })
        .mockRejectedValueOnce(new Error("network")),
    };
    await expect(
      syncArrivalFacts(
        source as never,
        target as never,
        lease,
        Date.now() + 10000,
        { checkpoint },
      ),
    ).rejects.toThrow("network");
    expect(checkpoint).toHaveBeenCalledWith("next", false);
    expect(target.finish).not.toHaveBeenCalled();
    const tail = api([
      { contractVersion: 2, items: [], nextCursor: null, issues: [] },
    ]);
    await syncArrivalFacts(
      tail as never,
      target as never,
      lease,
      Date.now() + 10000,
      { cursor: "next", checkpoint },
    );
    expect(tail.arrivalFactsPage).toHaveBeenCalledWith(50, "next");
    expect(target.finish).toHaveBeenCalledWith(lease);
  });
  it("checkpoints inside a large page and resumes without archiving unprocessed people", async () => {
    const people = Array.from({ length: 50 }, (_, i) => ({
      personUid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      code1c: null,
      participations: [],
    }));
    const target = projection();
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const checkpoint = vi.fn();
    target.apply.mockImplementation(async () => {
      now += 1;
    });
    try {
      const source = {
        arrivalFactsPage: vi
          .fn()
          .mockImplementation(async (_limit, cursor) => ({
            contractVersion: 2,
            items: cursor
              ? people.slice(
                  people.findIndex((p) => p.personUid === cursor) + 1,
                )
              : people,
            nextCursor: null,
            issues: [],
          })),
      };
      await syncArrivalFacts(source as never, target as never, lease, 20, {
        checkpoint,
      });
      expect(target.finish).not.toHaveBeenCalled();
      expect(target.apply).toHaveBeenCalledTimes(20);
      const cursor = checkpoint.mock.lastCall![0];
      now = 0;
      await syncArrivalFacts(source as never, target as never, lease, 100, {
        cursor,
        checkpoint,
      });
      expect(target.apply).toHaveBeenCalledTimes(50);
      expect(
        new Set(target.apply.mock.calls.map((call) => call[0].personUid)).size,
      ).toBe(50);
      expect(source.arrivalFactsPage).toHaveBeenCalledWith(50, cursor);
      expect(target.finish).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
  it("saves an incomplete pass after an invalid item within a page", async () => {
    const target = projection(),
      checkpoint = vi.fn();
    const personUid = "00000000-0000-4000-8000-000000000001";
    await syncArrivalFacts(
      api([
        {
          contractVersion: 2,
          items: [{}, { personUid, code1c: null, participations: [] }],
          nextCursor: null,
          issues: [],
        },
      ]) as never,
      target as never,
      lease,
      Date.now() + 10000,
      { checkpoint },
    );
    expect(target.apply).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledWith(personUid, true);
    expect(target.finish).not.toHaveBeenCalled();
  });
  it("finishes a complete empty snapshot", async () => {
    const target = projection();
    await syncArrivalFacts(
      api([
        { contractVersion: 2, items: [], nextCursor: null, issues: [] },
      ]) as never,
      target as never,
      lease,
      Date.now() + 10000,
    );
    expect(target.finish).toHaveBeenCalledWith(lease);
  });
});

import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { afterEach, expect, it, vi } from "vitest";
import { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const makeClient = () =>
  new ErpWorkspaceClient(
    new ConfigService({
      ERP_COMMUNICATIONS_URL: "https://erp.invalid/",
      ERP_CANDIDATE_TOKEN: "token",
      ERP_USERNAME: "user",
      ERP_PASSWORD: "pass",
    }),
  );
afterEach(() => vi.unstubAllGlobals());
it("splits an oversized batch without losing per-candidate outcomes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const { candidateUids } = JSON.parse(options.body);
      if (candidateUids.length > 1)
        return new Response("x".repeat(2 * 1024 * 1024 + 1));
      return Response.json({
        items: candidateUids.map((candidateUid: string) => ({
          candidateUid,
          deleted: true,
        })),
      });
    }),
  );
  await expect(makeClient().candidateProfilesBatch(ids)).resolves.toEqual({
    items: ids.map((candidateUid) => ({ candidateUid, deleted: true })),
  });
});
it("keeps successful outcomes when an isolated oversized item cannot be loaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const { candidateUids } = JSON.parse(options.body);
      if (candidateUids.length > 1 || candidateUids[0] === ids[1])
        return new Response("x".repeat(2 * 1024 * 1024 + 1));
      return Response.json({
        items: [{ candidateUid: ids[0], deleted: true }],
      });
    }),
  );
  expect((await makeClient().candidateProfilesBatch(ids)).items).toEqual([
    { candidateUid: ids[0], deleted: true },
    { candidateUid: ids[1], error: { code: "ERP_BATCH_SIZE_OR_TIMEOUT" } },
  ]);
});
it("limits simultaneous requests across concurrent batch calls", async () => {
  let active = 0,
    peak = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      const { candidateUids } = JSON.parse(options.body);
      return Response.json({
        items: candidateUids.map((candidateUid: string) => ({
          candidateUid,
          deleted: true,
        })),
      });
    }),
  );
  const client = makeClient();
  await Promise.all(
    Array.from({ length: 4 }, () => client.candidateProfilesBatch(ids)),
  );
  expect(peak).toBeLessThanOrEqual(2);
});

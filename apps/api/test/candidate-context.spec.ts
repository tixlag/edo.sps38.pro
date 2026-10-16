import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { ErpCandidateClient } from "../src/documents/erp-candidate.client";
import { CandidateContextService } from "../src/documents/candidate-context.service";

const chatUuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
const card = {
  uuid: chatUuid,
  name: " Иван Петров ",
  citizenship: "RU",
  position: { code: "000491", name: "Сварщик" },
  project: { code: "00008" },
  mentor: { name: " Наставник " },
};
const config = new ConfigService({
  ERP_CANDIDATE_URL: "https://erp.example/Candidate",
  ERP_CANDIDATE_TOKEN: "erp-secret",
  ERP_USERNAME: "user",
  ERP_PASSWORD: "password",
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ERP candidate adapter", () => {
  it("requests the card using server credentials and normalizes its profile", async () => {
    let request: Request | undefined;
    vi.stubGlobal(
      "fetch",
      async (url: string, init: Parameters<typeof fetch>[1]) => {
        request = new Request(url, init);
        return Response.json(card);
      },
    );
    expect(
      await new ErpCandidateClient(config).findByChatUuid(chatUuid),
    ).toEqual({
      ...card,
      name: "Иван Петров",
      citizenship: "ru",
      mentor: { name: "Наставник" },
    });
    expect(request!.url).toBe("https://erp.example/Candidate?uuid=" + chatUuid);
    expect(request!.headers.get("token")).toBe("erp-secret");
    expect(request!.headers.get("authorization")).toBe(
      "Basic dXNlcjpwYXNzd29yZA==",
    );
    expect(request!.redirect).toBe("error");
  });
  it.each([401, 403, 404, 503])(
    "returns safe classified errors for HTTP %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        async () => new Response("secret ERP body", { status }),
      );
      const promise = new ErpCandidateClient(config).findByChatUuid(chatUuid);
      await expect(promise).rejects.toMatchObject({
        status,
        transient: status === 503,
      });
      await expect(promise).rejects.not.toThrow("secret");
    },
  );
  it.each([
    { ...card, uuid: "00000000-0000-4000-8000-000000000001" },
    { ...card, position: {} },
    { ...card, citizenship: "Russia" },
    [],
  ])("rejects incorrect source cards", async (body) => {
    vi.stubGlobal("fetch", async () => Response.json(body));
    await expect(
      new ErpCandidateClient(config).findByChatUuid(chatUuid),
    ).rejects.toMatchObject({ transient: false });
  });
  it("fails closed without credentials and does not call ERP", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new ErpCandidateClient(new ConfigService({})).findByChatUuid(chatUuid),
    ).rejects.toMatchObject({ transient: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function setup() {
  const identity = {
    byUuid: vi.fn(async () => ({ chatUuid, code1c: null as string | null })),
    byEmployee: vi.fn(async () => ({ chatUuid, code1c: "000123" })),
  };
  const erp = {
    findByChatUuid: vi.fn(async () => ({ ...card, citizenship: "ru" })),
  };
  let entry: { snapshot: typeof card; freshUntil: number } | null = null;
  const cache = {
    get: vi.fn(async () => entry),
    acquire: vi.fn(async () => true),
    write: vi.fn(async (_id: string, _owner: string, next: typeof entry) => {
      entry = next;
    }),
    release: vi.fn(async () => {}),
  };
  const service = new CandidateContextService(
    identity as never,
    erp as never,
    cache as never,
  );
  return { identity, erp, cache, service };
}
describe("EDO candidate context", () => {
  it("combines ERP profile with the authoritative LK employee link and rechecks LK on cache hits", async () => {
    const { service, identity, erp } = setup();
    expect(await service.context(chatUuid)).toMatchObject({
      chatUuid,
      code1c: null,
      positionCode1c: "000491",
      citizenship: "ru",
      projectCode1c: "00008",
    });
    identity.byUuid.mockResolvedValue({ chatUuid, code1c: "000123" });
    expect(await service.context(chatUuid)).toMatchObject({ code1c: "000123" });
    expect(identity.byUuid).toHaveBeenCalledTimes(2);
    expect(erp.findByChatUuid).toHaveBeenCalledOnce();
  });
  it("never serves a cached profile when LK cannot verify the chat", async () => {
    const { service, identity } = setup();
    await service.context(chatUuid);
    identity.byUuid.mockRejectedValue(new Error("LK unavailable"));
    await expect(service.context(chatUuid)).rejects.toThrow("LK unavailable");
  });
  it("fetches ERP without a cache when Redis is unavailable", async () => {
    const { service, cache } = setup();
    cache.get.mockRejectedValue(new Error("redis down"));
    expect(await service.context(chatUuid)).toMatchObject({
      positionCode1c: "000491",
    });
  });
  it("merges simultaneous card requests but resolves each request employee link independently", async () => {
    const { service, erp, identity } = setup();
    const results = await Promise.all([
      service.context(chatUuid),
      service.context(chatUuid),
      service.context(chatUuid),
    ]);
    expect(results).toHaveLength(3);
    expect(erp.findByChatUuid).toHaveBeenCalledOnce();
    expect(identity.byUuid).toHaveBeenCalledTimes(3);
  });
  it("uses a stale card only for transient ERP errors and clears it on permanent errors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { service, erp } = setup();
    await service.context(chatUuid);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    erp.findByChatUuid.mockRejectedValue(
      Object.assign(new Error("ERP unavailable"), {
        transient: true,
        status: 503,
      }),
    );
    expect(await service.context(chatUuid)).toMatchObject({
      positionCode1c: "000491",
    });
    vi.spyOn(Date, "now").mockReturnValue(1_100_000);
    erp.findByChatUuid.mockRejectedValue(
      Object.assign(new Error("missing"), { transient: false, status: 404 }),
    );
    await expect(service.context(chatUuid)).rejects.toMatchObject({
      status: 404,
    });
  });
});

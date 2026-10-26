import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { ErpCandidateClient } from "../src/documents/erp-candidate.client";
import { CandidateContextService } from "../src/documents/candidate-context.service";
import { CandidateDocumentsService } from "../src/documents/candidate-documents.service";
import { LkCandidateIdentityService } from "../src/documents/lk-candidate-identity.service";

// Production Candidate envelope, with synthetic personal data only.
const productionCard = {
  candidate: {
    uuid: "",
    name: " Тестовый Кандидат ",
    photoPath: "",
    birthDate: "1990-01-02",
    citizenship: "RU",
    sex: "",
    code1C: "ER-0012211",
    isReemployment: false,
  },
  position: { name: "Программист", code: "000000173" },
  project: { name: "Тестовый объект", code: "P1" },
  manager: { name: "Тестовый менеджер", code: "M1" },
  master: { name: "", code: "" },
  supervisor: { name: "", code: "" },
  mentor: { name: "Наставник", position: "Специалист", code1C: "N1" },
};

const chatUuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
const card = {
  uuid: chatUuid,
  erpUid: "796f7bb9-caf4-43f2-b5ab-c52bc6e94899",
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
  vi.useRealTimers();
});

describe("ERP candidate adapter", () => {
  it("looks up IG by code1c and accepts an empty chat uuid", async () => {
    let requested: URL | undefined;
    vi.stubGlobal("fetch", async (url: URL) => {
      requested = url;
      return Response.json({
        ...card,
        uuid: "",
        code1C: "000123",
        citizenship: "UZ",
      });
    });
    const result = await new ErpCandidateClient(config).findByEmployeeCode(
      "000123",
    );
    expect(requested?.searchParams.get("code1c")).toBe("000123");
    expect(requested?.searchParams.has("code_1c")).toBe(false);
    expect(requested?.searchParams.has("uuid")).toBe(false);
    expect(result).toMatchObject({
      uuid: null,
      code1C: "000123",
      citizenship: "uz",
    });
  });

  it("rejects a card belonging to another employee on a code1c lookup", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ ...card, uuid: null, code1C: "other" }),
    );
    await expect(
      new ErpCandidateClient(config).findByEmployeeCode("000123"),
    ).rejects.toMatchObject({ transient: false });
  });

  it("normalizes the production nested Candidate envelope using code1c", async () => {
    let requested: URL | undefined;
    vi.stubGlobal("fetch", async (url: URL) => {
      requested = url;
      return Response.json(productionCard);
    });
    expect(
      await new ErpCandidateClient(config).findByEmployeeCode("ER-0012211"),
    ).toEqual({
      uuid: null,
      name: "Тестовый Кандидат",
      birthDate: "1990-01-02",
      citizenship: "ru",
      code1C: "ER-0012211",
      isReemployment: false,
      position: productionCard.position,
      project: productionCard.project,
      manager: "Тестовый менеджер",
      managerCode1C: "M1",
      mentor: productionCard.mentor,
    });
    expect(requested?.search).toBe("?code1c=ER-0012211");
  });

  it("reads the chat uuid and citizenship from candidate on chat lookups too", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ...productionCard,
        candidate: {
          ...productionCard.candidate,
          uuid: chatUuid,
          citizenship: "UZ",
        },
      }),
    );
    expect(
      await new ErpCandidateClient(config).findByChatUuid(chatUuid),
    ).toMatchObject({
      uuid: chatUuid,
      citizenship: "uz",
      position: productionCard.position,
    });
  });

  it("checks nested employee identity even when a misleading top-level code matches", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ...productionCard,
        code1C: "ER-0012211",
        candidate: { ...productionCard.candidate, code1C: "other" },
      }),
    );
    await expect(
      new ErpCandidateClient(config).findByEmployeeCode("ER-0012211"),
    ).rejects.toMatchObject({ code: "ERP_CONTRACT_ERROR" });
  });

  it.each([null, [], "invalid"])(
    "rejects a malformed nested candidate %j without falling back to flat fields",
    async (candidate) => {
      vi.stubGlobal("fetch", async () =>
        Response.json({
          ...card,
          code1C: "ER-0012211",
          candidate,
        }),
      );
      await expect(
        new ErpCandidateClient(config).findByEmployeeCode("ER-0012211"),
      ).rejects.toMatchObject({ code: "ERP_CONTRACT_ERROR" });
    },
  );

  it("does not mistake a nested personal position for the top-level position", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ...productionCard,
        position: { code: "", name: "" },
        candidate: {
          ...productionCard.candidate,
          position: productionCard.position,
        },
      }),
    );
    await expect(
      new ErpCandidateClient(config).findByEmployeeCode("ER-0012211"),
    ).rejects.toMatchObject({
      code: "CANDIDATE_PROFILE_INCOMPLETE",
      fields: ["positionCode"],
    });
  });
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
  it("resolves trusted candidate identity even when the ERP profile is incomplete", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ uuid: chatUuid, erpUid: card.erpUid, position: null }),
    );
    expect(
      await new ErpCandidateClient(config).resolveIdentityByChat(chatUuid),
    ).toBe(card.erpUid);
  });
  it("fails closed when catalog is configured but trusted identity cannot be resolved", async () => {
    await expect(
      new ErpCandidateClient(
        new ConfigService({
          ERP_COMMUNICATIONS_URL: "https://erp.example/communications",
        }),
      ).resolveIdentityByChat(chatUuid),
    ).rejects.toThrow();
    vi.stubGlobal("fetch", async () => Response.json({ uuid: chatUuid }));
    await expect(
      new ErpCandidateClient(config).resolveIdentityByChat(chatUuid),
    ).rejects.toThrow();
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
    {} as never,
  );
  return { identity, erp, cache, service };
}
describe("EDO candidate context", () => {
  it("serves own forms after the real LK identity adapter returns 404, with no local employee projection", async () => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      if (url.hostname === "lk.example") {
        expect(url.pathname).toBe(
          "/api/internal/edo/v1/employees/ER-0012211/candidate-chat",
        );
        return Response.json({ message: "Not found" }, { status: 404 });
      }
      expect(url.searchParams.get("code1c")).toBe("ER-0012211");
      expect(url.searchParams.has("code_1c")).toBe(false);
      return Response.json(productionCard);
    });
    const identity = new LkCandidateIdentityService(
      new ConfigService({
        LK_BASE_URL: "https://lk.example",
        LK_EDO_INTERNAL_TOKEN: "test-token",
      }),
    );
    const { cache } = setup();
    // No Prisma dependency/projection is supplied: this path must use Candidate.
    const contexts = new CandidateContextService(
      identity,
      new ErpCandidateClient(config),
      cache as never,
    );
    const catalog = { list: vi.fn(async () => ({ items: [] })) };
    const service = new CandidateDocumentsService(
      contexts,
      identity,
      catalog as never,
      null as never,
      null as never,
      null as never,
    );
    expect(await service.ownForms("ER-0012211")).toMatchObject({
      context: {
        chatUuid: null,
        code1c: "ER-0012211",
        positionCode1c: "000000173",
        citizenship: "ru",
        projectCode1c: "P1",
        candidateSnapshot: { name: "Тестовый Кандидат" },
      },
      catalog: { items: [] },
    });
    expect(catalog.list).toHaveBeenCalledWith("000000173", "ru");
    expect(requests.map((url) => url.hostname)).toEqual([
      "lk.example",
      "erp.example",
    ]);
  });
  it("gets a chatless IG employee profile from Candidate, without querying the LK projection", async () => {
    const { service, erp } = setup();
    Object.assign(erp, {
      findByEmployeeCode: vi.fn(async () => ({
        ...card,
        uuid: null,
        code1C: "000123",
        citizenship: "uz",
      })),
    });
    expect(await service.forEmployee("000123")).toMatchObject({
      chatUuid: null,
      code1c: "000123",
      citizenship: "uz",
      positionCode1c: "000491",
    });
  });

  it("does not let a returned chat uuid attach another employee's documents", async () => {
    const { service, erp, identity } = setup();
    Object.assign(erp, {
      findByEmployeeCode: vi.fn(async () => ({
        ...card,
        code1C: "000123",
        citizenship: "uz",
      })),
    });
    identity.byUuid.mockResolvedValue({ chatUuid, code1c: "other" });
    await expect(service.forEmployee("000123")).rejects.toMatchObject({
      code: "LK_CONTRACT_ERROR",
    });
  });
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
  it("refreshes a fresh legacy card that lacks the trusted ERP candidate identifier", async () => {
    const { service, cache, erp } = setup();
    const legacy: Partial<typeof card> = { ...card };
    delete legacy.erpUid;
    cache.get.mockResolvedValue({
      snapshot: legacy,
      freshUntil: Date.now() + 60000,
    } as never);
    await service.context(chatUuid);
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
  it("waits for a peer's slow card without issuing a duplicate ERP request", async () => {
    vi.useFakeTimers();
    const { service, cache, erp } = setup();
    const readyAt = Date.now() + 6500;
    cache.acquire.mockResolvedValue(false);
    cache.get.mockImplementation(async () =>
      Date.now() >= readyAt
        ? {
            snapshot: { ...card, citizenship: "ru" },
            freshUntil: Date.now() + 60_000,
          }
        : null,
    );
    const request = service.context(chatUuid);
    await vi.advanceTimersByTimeAsync(7000);
    await expect(request).resolves.toMatchObject({ citizenship: "ru" });
    expect(erp.findByChatUuid).not.toHaveBeenCalled();
  });
  it("does not cancel a shared ERP request when one caller leaves", async () => {
    const { service, erp } = setup();
    let complete!: (value: typeof card) => void;
    erp.findByChatUuid.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const abort = new AbortController();
    const leaving = service.context(chatUuid, abort.signal);
    const remaining = service.context(chatUuid);
    const cancelled = expect(leaving).rejects.toMatchObject({
      code: "DOCUMENTS_TIMEOUT",
    });
    abort.abort();
    await cancelled;
    complete({ ...card, citizenship: "ru" });
    await expect(remaining).resolves.toMatchObject({ citizenship: "ru" });
    expect(erp.findByChatUuid).toHaveBeenCalledOnce();
  });
});

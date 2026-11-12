import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import {
  ErpWorkspaceClient,
  erpCardSchema,
} from "../src/documents/erp-workspace.client";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const actor: AuthPrincipal = {
  uuid: randomUUID(),
  code1c: "ACTOR",
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: { "20002": [] },
};
const candidateUid = randomUUID(),
  personUid = randomUUID();
const sparseCard = {
  erpUid: candidateUid,
  chatUuid: null,
  code1C: null,
  personUid: null,
  reviewGroup: "RU",
  fullName: "Historical Person",
  phone: "+70000000000",
  birthDate: null,
  citizenship: null,
  position: null,
  project: null,
  manager: null,
  mentor: null,
  status: { id: "Dismissed", name: "Dismissed" },
  history: [],
};
function setup() {
  const config = new ConfigService({
    ERP_COMMUNICATIONS_URL: "https://erp.invalid/bridge",
    ERP_CANDIDATE_TOKEN: "test",
    ERP_USERNAME: "test",
    ERP_PASSWORD: "test",
    JWT_SECRET: "selection-test",
  });
  let row: any = {
    id: randomUUID(),
    erpUid: candidateUid,
    reviewGroup: "RU",
    chatUuid: null,
    personUid: null,
  };
  const updates: any[] = [];
  const tx = {
    candidate: {
      findMany: vi.fn(async () => [row]),
      findUniqueOrThrow: vi.fn(async () => row),
      update: vi.fn(async ({ data }: any) => {
        updates.push(data);
        row = { ...row, ...data };
        return row;
      }),
    },
    document: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $queryRaw: vi.fn(async () => []),
  };
  const prisma = { $transaction: async (fn: any) => fn(tx) };
  const catalog = { list: vi.fn() };
  const service = new CandidateWorkspaceService(
    prisma as never,
    new ErpWorkspaceClient(config),
    { candidate: async () => row } as never,
    { logInTransaction: async () => {} } as never,
    config,
    catalog as never,
    null as never,
  );
  return { service, updates, catalog };
}
afterEach(() => vi.unstubAllGlobals());
describe("candidate card creation and recovery", () => {
  it.each([
    "SOURCE_COMMENT_REQUIRED",
    "SOURCE_REFERRER_REQUIRED",
    "INTERNSHIP_END_DATE_REQUIRED",
  ])(
    "keeps %s a definitive validation rejection, including operation recovery",
    async (code) => {
      const { service } = setup();
      vi.stubGlobal("fetch", async () =>
        Response.json({ code }, { status: 400 }),
      );
      await expect(
        service.create(actor, {
          requestId: randomUUID(),
          fields: {
            fullName: "Person",
            phone: "+70000000000",
            birthDate: "1990-01-01",
          },
        }),
      ).rejects.toThrow(code);
      vi.stubGlobal("fetch", async () =>
        Response.json({ state: "COMPLETED", httpStatus: 400, code }),
      );
      expect(await service.operation(actor, randomUUID())).toEqual({
        state: "REJECTED",
        code,
      });
    },
  );
  it("opens exact UID with sparse birth/citizenship and excluded status without a status mutation", async () => {
    const { service, updates } = setup();
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (input: URL, init: any) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json(sparseCard);
    });
    const card = await service.open(actor, candidateUid);
    expect(card).toMatchObject({
      birthDate: null,
      citizenship: null,
      status: { id: "Dismissed" },
      person: null,
      contacts: [],
      gph: false,
    });
    expect(card).not.toHaveProperty("erpUid");
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get("action")).toBe("card");
    expect(calls[0].url.searchParams.get("candidate")).toBe(candidateUid);
    expect(calls[0].init.method).toBe("GET");
    expect(updates.at(-1)).toMatchObject({
      birthDate: null,
      citizenship: null,
      reviewGroup: "RU",
    });
  });
  it("keeps direct person picker signed and forwards only exact acknowledged duplicates", async () => {
    const { service } = setup();
    let created: any;
    vi.stubGlobal("fetch", async (input: URL, init: any) => {
      const action = new URL(String(input)).searchParams.get("action");
      if (action === "persons")
        return Response.json({
          items: [
            {
              id: personUid,
              name: "Person",
              birthDate: null,
              candidateUids: [candidateUid],
            },
          ],
        });
      if (action === "person-matches")
        return Response.json({
          items: [],
          candidates: [
            {
              id: candidateUid,
              name: "Person",
              birthDate: null,
              matchedName: true,
              matchedPhone: false,
              matchedBirthDate: false,
            },
          ],
        });
      created = JSON.parse(init.body);
      return Response.json(sparseCard);
    });
    const picker = await service.references("persons", actor, "Person");
    expect(picker.items[0].id).not.toBe(personUid);
    expect(picker.items[0].candidateUids).toEqual([candidateUid]);
    expect(picker.items[0].personUid).toBe(personUid);
    const matches = await service.personMatches(actor, {
      scope: "creation",
      fullName: "Person",
    });
    await expect(
      service.create(actor, {
        requestId: randomUUID(),
        fields: {
          fullName: "Person",
          phone: "+70000000000",
          birthDate: "1990-01-01",
        },
        personSelection: picker.items[0].id,
        ignoredSelections: [matches.candidates[0].selection],
      }),
    ).rejects.toThrow("CONTRADICTORY");
    await service.create(actor, {
      requestId: randomUUID(),
      fields: {
        fullName: "Person",
        phone: "+70000000000",
        birthDate: "1990-01-01",
      },
      ignoredSelections: [picker.items[0].id, matches.candidates[0].selection],
    });
    expect(created.ignoredDuplicates).toEqual({
      persons: [personUid],
      candidates: [candidateUid],
    });
    await expect(
      service.create(
        { ...actor, uuid: randomUUID() },
        {
          requestId: randomUUID(),
          fields: {
            fullName: "Person",
            phone: "+70000000000",
            birthDate: "1990-01-01",
          },
          ignoredSelections: [picker.items[0].id],
        },
      ),
    ).rejects.toThrow("устарел");
    await expect(
      service.personMatches(
        { ...actor, accessRules: { "20011": [] } },
        { scope: "creation", fullName: "Person" },
      ),
    ).rejects.toThrow("review group");
  });
  it("returns durable rejection or success and never infers an unknown result from a card", async () => {
    const { service } = setup();
    let result: any = { state: "UNKNOWN" };
    const queries: URL[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      queries.push(new URL(String(input)));
      return Response.json(result);
    });
    const requestId = randomUUID();
    expect(await service.operation(actor, requestId)).toEqual({
      state: "UNKNOWN",
    });
    expect(queries[0].searchParams.get("actor")).toBe("ACTOR");
    result = {
      state: "COMPLETED",
      httpStatus: 409,
      code: "CANDIDATE_DUPLICATE_REQUIRES_REVIEW",
    };
    expect(await service.operation(actor, requestId)).toEqual({
      state: "REJECTED",
      code: result.code,
    });
    result = {
      state: "COMPLETED",
      httpStatus: 409,
      code: "IDEMPOTENCY_CONFLICT",
    };
    expect(await service.operation(actor, requestId)).toEqual({
      state: "UNKNOWN",
      code: "IDEMPOTENCY_CONFLICT",
    });
    result = { state: "COMPLETED", httpStatus: 201, card: sparseCard };
    expect(await service.operation(actor, requestId)).toMatchObject({
      state: "SUCCEEDED",
      candidate: { birthDate: null, status: { id: "Dismissed" } },
    });
    expect(
      queries.every((url) => url.searchParams.get("action") === "operation"),
    ).toBe(true);
  });
  it("blocks document requirements when citizenship is unknown", async () => {
    const { service, catalog } = setup();
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ...sparseCard,
        position: { code: "POS", name: "Position" },
      }),
    );
    await expect(
      service.requirements("candidate", actor),
    ).rejects.toMatchObject({
      code: "CANDIDATE_PROFILE_INCOMPLETE",
      fields: ["citizenship"],
    });
    expect(catalog.list).not.toHaveBeenCalled();
  });
  it("refuses healing a chat owner by deleting a candidate with previous document decisions", async () => {
    const row = {
      id: "chat-owner",
      erpUid: null,
      chatUuid: randomUUID(),
      reviewGroup: "RU",
      code1c: "EMP",
      personUid: null,
    };
    const ghost = {
      ...row,
      id: "erp-owner",
      erpUid: candidateUid,
      chatUuid: null,
      _count: { documents: 0, previousDocuments: 1 },
    };
    const deleted = vi.fn();
    const tx = {
      candidate: {
        findMany: async () => [{ ...row, erpUid: candidateUid }],
        findUniqueOrThrow: async () => ({ ...row, erpUid: candidateUid }),
        findFirst: async () => ghost,
        delete: deleted,
        update: async () => ({ ...row, erpUid: candidateUid }),
      },
      document: { updateMany: async () => ({ count: 0 }) },
      $queryRaw: async () => [],
    };
    const service = new CandidateWorkspaceService(
      { $transaction: async (fn: any) => fn(tx) } as never,
      { card: async () => erpCardSchema.parse(sparseCard) } as never,
      { candidate: async () => row } as never,
      { logInTransaction: async () => {} } as never,
      new ConfigService(),
      null as never,
      null as never,
      undefined,
      { resolveIdentityByChat: async () => candidateUid } as never,
    );
    await expect(service.card(row.id, actor)).rejects.toThrow(
      "CANDIDATE_IDENTITY_CONFLICT",
    );
    expect(deleted).not.toHaveBeenCalled();
  });
  it("preserves contact row identifiers without serialized internal fields", () => {
    const card = erpCardSchema.parse({
      ...sparseCard,
      contacts: [
        {
          rowNumber: 4,
          typeId: "Email",
          kindId: randomUUID(),
          presentation: "person@example.test",
          comment: "keep",
          fieldValues: "private",
        },
      ],
    });
    expect(card.contacts[0]).toMatchObject({
      rowNumber: 4,
      typeId: "Email",
      presentation: "person@example.test",
      comment: "keep",
    });
    expect(card.contacts[0]).not.toHaveProperty("fieldValues");
  });
});

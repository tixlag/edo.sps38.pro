import "reflect-metadata";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import {
  CandidateFieldsDto,
  CreateCandidateDto,
  UpdateCandidateDto,
} from "../src/communications/candidate-workspace.dto";
import type { AuthPrincipal } from "../src/auth/auth-principal";
const fields = {
  fullName: "Synthetic Person",
  phone: "+70000000000",
  birthDate: "1990-01-01",
  citizenship: "ru",
  positionCode: "POS",
  managerId: randomUUID(),
};
it.each(["mentor", "mentorId", "erpUid", "personUid", "chatUuid", "code1c"])(
  "rejects editable API field %s",
  async (key) => {
    const input = plainToInstance(CandidateFieldsDto, {
      ...fields,
      [key]: "forbidden",
    });
    expect((await validate(input)).some((e) => e.property === key)).toBe(true);
  },
);
it("requires creation fields and a stable request UUID", async () => {
  expect(
    await validate(plainToInstance(CreateCandidateDto, {})),
  ).not.toHaveLength(0);
});
it("validates partial edits without making omitted ERP fields mandatory", async () => {
  expect(
    await validate(
      plainToInstance(UpdateCandidateDto, {
        requestId: randomUUID(),
        fields: { phone: "+70000000001" },
      }),
    ),
  ).toHaveLength(0);
});
const db = process.env.EDO_TEST_DATABASE_URL;
if (db && !/^mysql:\/\/root:isolated-test@127\.0\.0\.1:3308\/edo$/.test(db))
  throw new Error("Refuse non-isolated DB");
describe.skipIf(!db)(
  "ERP candidate workspace with disposable MariaDB projection",
  () => {
    let prisma: PrismaService, service: CandidateWorkspaceService, id: string;
    const actor: AuthPrincipal = {
      uuid: `workspace-${randomUUID()}`,
      code1c: "VERIFIED-ACTOR",
      sid: null,
      deviceId: null,
      expiresAt: null,
      accessRules: { "20002": [] },
    };
    const personUid = randomUUID(),
      erpUid = randomUUID(),
      sourceId = "opaque-original";
    let card = {
      erpUid,
      chatUuid: null,
      personUid: null as string | null,
      code1C: null,
      reviewGroup: "RU",
      ...fields,
      position: { code: "POS", name: "Position" },
      project: null,
      manager: { id: fields.managerId, name: "Manager" },
      mentor: { name: "ERP mentor" },
      status: { id: "Подбор", name: "Подбор" },
      history: [],
    };
    const calls: { action: string; body: Record<string, unknown> }[] = [];
    const replay = new Map<
      string,
      { fingerprint: string; card: typeof card }
    >();
    const fetcher = async (
      input: URL | string,
      init?: Parameters<typeof fetch>[1],
    ) => {
      const action = new URL(String(input)).searchParams.get("action")!;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ action, body });
      if (action === "persons")
        return Response.json({
          items: [
            {
              id: personUid,
              name: "Synthetic Person",
              birthDate: "1990-01-01",
            },
          ],
        });
      if (action === "statuses")
        return Response.json({
          items: [
            { id: "Подбор", name: "Подбор", editable: true },
            {
              id: "ПланНаЗаезд",
              name: "План на заезд",
              editable: true,
              requiresProject: true,
              requiresPlannedArrivalDate: true,
            },
            {
              id: "ЗаездПодтвержден",
              name: "Заезд подтверждён",
              editable: false,
            },
          ],
        });
      if (action === "person-documents")
        return Response.json({
          items: [
            {
              id: sourceId,
              documentUid: randomUUID(),
              title: "Previous passport",
              fields: { number: "0001" },
              expiresAt: "2030-01-01",
              originalAvailable: true,
              recheckStatus: "REQUIRES_REVIEW",
            },
          ],
        });
      if (action === "person-document-original")
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "application/pdf" },
        });
      if (init?.method === "POST") {
        const fingerprint = JSON.stringify({ action, body }),
          previous = replay.get(body.requestId);
        if (previous)
          return previous.fingerprint === fingerprint
            ? Response.json(previous.card)
            : Response.json({ code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
        if (action === "create") card = { ...card, ...body.fields };
        if (action === "update") card = { ...card, ...body.fields };
        if (action === "link-person")
          card = { ...card, personUid: body.personUid };
        if (action === "status")
          card = {
            ...card,
            status: { id: body.statusId, name: body.statusId },
          };
        replay.set(body.requestId, {
          fingerprint,
          card: structuredClone(card),
        });
      }
      return Response.json(card);
    };
    beforeAll(async () => {
      prisma = new PrismaService({ datasourceUrl: db });
      const config = new ConfigService({
        ERP_COMMUNICATIONS_URL: "http://127.0.0.1:1/candidate-communications",
        ERP_CANDIDATE_TOKEN: "test",
        ERP_USERNAME: "test",
        ERP_PASSWORD: "test",
        JWT_SECRET: "isolated-selection",
      });
      service = new CandidateWorkspaceService(
        prisma,
        new ErpWorkspaceClient(config),
        new DocumentAccessService(prisma),
        new AuditService(prisma),
        config,
      );
    });
    afterEach(() => vi.unstubAllGlobals());
    afterAll(async () => {
      await prisma.candidatePreviousDocument.deleteMany({
        where: { candidateId: id },
      });
      await prisma.auditLog.deleteMany({ where: { actorId: actor.uuid } });
      await prisma.candidate.deleteMany({ where: { erpUid } });
      await prisma.$disconnect();
    });
    it("creates in ERP with verified actor and same request retries preserve one EDO card", async () => {
      vi.stubGlobal("fetch", fetcher);
      const body = { requestId: randomUUID(), fields };
      const first = await service.create(actor, body);
      id = first.id;
      const second = await service.create(actor, body);
      expect(second.id).toBe(id);
      expect(await prisma.candidate.count({ where: { erpUid } })).toBe(1);
      expect(first).toMatchObject({
        status: { id: "Подбор" },
        hasChat: false,
        mentor: { name: "ERP mentor" },
      });
      expect(first).not.toHaveProperty("erpUid");
      expect(first).not.toHaveProperty("code1c");
      expect(calls.find((c) => c.action === "create")?.body.actor).toBe(
        "VERIFIED-ACTOR",
      );
    });
    it("forwards only supplied fields and displays ERP-confirmed edits", async () => {
      vi.stubGlobal("fetch", fetcher);
      const result = await service.update(id, actor, {
        requestId: randomUUID(),
        fields: { phone: "+70000000001" },
      });
      expect(calls.findLast((c) => c.action === "update")?.body.fields).toEqual(
        { phone: "+70000000001" },
      );
      expect(result.fullName).toBe(fields.fullName);
      expect(result.phone).toBe("+70000000001");
      expect(
        (await prisma.candidate.findUniqueOrThrow({ where: { id } })).phone,
      ).toBe(result.phone);
    });
    it("supports all dynamic ERP statuses, optional comments, and blocks dispatcher transitions", async () => {
      vi.stubGlobal("fetch", fetcher);
      await expect(
        service.status(id, actor, {
          requestId: randomUUID(),
          statusId: "ЗаездПодтвержден",
        }),
      ).rejects.toThrow("диспетчером");
      await expect(
        service.status(id, actor, {
          requestId: randomUUID(),
          statusId: "ПланНаЗаезд",
        }),
      ).rejects.toThrow("объект");
      const result = await service.status(id, actor, {
        requestId: randomUUID(),
        statusId: "Подбор",
      });
      expect(result.status.id).toBe("Подбор");
      expect(
        calls.findLast((c) => c.action === "status")?.body,
      ).not.toHaveProperty("comment");
    });
    it("links only explicit server-issued person choices and rejects a forged ERP uid", async () => {
      vi.stubGlobal("fetch", fetcher);
      const search = await service.references("persons", actor, "Synthetic");
      const choice = search.items[0].id;
      expect(choice).not.toBe(personUid);
      await expect(
        service.link(id, actor, {
          requestId: randomUUID(),
          personSelection: personUid,
        }),
      ).rejects.toThrow("устарел");
      const result = await service.link(id, actor, {
        requestId: randomUUID(),
        personSelection: choice,
      });
      expect(result.linkedPerson).toBe(true);
      expect(result.id).toBe(id);
      expect(
        calls.findLast((c) => c.action === "link-person")?.body.personUid,
      ).toBe(personUid);
    });
    it("imports previous ERP originals as requiring review and persists current-cycle decisions", async () => {
      vi.stubGlobal("fetch", fetcher);
      const result = await service.previous(id, actor);
      expect(result.items[0].status).toBe("REQUIRES_REVIEW");
      const checked = await service.recheck(id, result.items[0].id, actor, {
        status: "CONFIRMED",
      });
      expect(checked.items[0].status).toBe("CONFIRMED");
      const again = await service.previous(id, actor);
      expect(again.items[0].status).toBe("CONFIRMED");
      expect(
        (await service.original(id, result.items[0].id, actor)).bytes,
      ).toEqual(Buffer.from([1, 2, 3]));
      expect(
        await prisma.auditLog.count({
          where: {
            entityId: result.items[0].id,
            actorId: actor.uuid,
            action: "DOCUMENT_FIELDS_UPDATED",
          },
        }),
      ).toBe(1);
    });
    it("opens sparse historical cards with missing position/status for correction", async () => {
      vi.stubGlobal("fetch", fetcher);
      card = { ...card, position: null as never, status: null as never };
      const result = await service.card(id, actor);
      expect(result.position).toBeNull();
      expect(result.status).toBeNull();
      const projected = await prisma.candidate.findUniqueOrThrow({
        where: { id },
      });
      expect(projected.positionCode).toBeNull();
      expect(projected.statusId).toBeNull();
    });
    it("IG review rights and audit cannot mutate RU candidate management", async () => {
      await expect(
        service.create(
          { ...actor, accessRules: { "20011": [] } },
          { requestId: randomUUID(), fields },
        ),
      ).rejects.toThrow("review group");
      await expect(
        service.update(
          id,
          { ...actor, accessRules: { "20005": [] } },
          { requestId: randomUUID(), fields: { phone: "+70000000000" } },
        ),
      ).rejects.toThrow("review group");
    });
  },
);

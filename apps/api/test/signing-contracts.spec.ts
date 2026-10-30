import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { randomUUID } from "node:crypto";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import {
  signingCandidateWhere,
  ownContractWhere,
} from "../src/contracts/contract-access";
import { ContractsService } from "../src/contracts/contracts.service";
import { ContractObjectsService } from "../src/contracts/contract-objects.service";
import { ContractFileService } from "../src/contracts/contract-file.service";
import { AuditService } from "../src/audit/audit.service";
import { ContractBank } from "../src/contracts/contract.dto";
import { ContractsController } from "../src/contracts/contracts.controller";

function user(
  uuid: string,
  rules: Record<string, string[]> = {},
  code1c: string | null = null,
): AuthPrincipal {
  return {
    uuid,
    accessRules: rules,
    code1c,
    sid: null,
    deviceId: null,
    expiresAt: null,
  };
}
const hr = user("test-contract-hr", { "20003": [], "20008": [] });
const employee = user("test-contract-employee", {}, "test-contract-code");
const outsider = user("test-contract-outsider", {}, "test-other-code");
const action = (revision: number) => ({ revision, requestId: randomUUID() });

describe("signing authorization boundaries", () => {
  it("allows signing with 20003 and location scope without review permissions", () => {
    expect(
      signingCandidateWhere(user("hr", { "20003": [], "20007": ["98"] })),
    ).toEqual({ OR: [{ locationId: { in: [98] } }] });
  });
  it("denies review or audit alone and denies unscoped signing", () => {
    expect(() =>
      signingCandidateWhere(user("review", { "20011": [], "20005": [] })),
    ).toThrow();
    expect(signingCandidateWhere(user("hr", { "20003": [] }))).toEqual({
      id: { in: [] },
    });
  });
  it("uses verified employee code without EDO administrative permissions", () => {
    expect(ownContractWhere(employee)).toMatchObject({
      recipientCode1c: employee.code1c,
    });
    expect(() => ownContractWhere(user("missing"))).toThrow();
  });
});

describe("contract multipart boundary", () => {
  it.each([
    "FST_REQ_FILE_TOO_LARGE",
    "FST_FILES_LIMIT",
    "FST_PARTS_LIMIT",
    "FST_FIELDS_LIMIT",
  ])("translates %s into 413", async (code) => {
    const controller = new ContractsController({
      detail: vi.fn().mockResolvedValue({}),
    } as never);
    const req = {
      parts: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw Object.assign(new Error("multipart limit"), { code });
          },
        }),
      }),
    };
    await expect(
      controller.upload("contract", hr, req as never),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("checks recipient access before reading any upload data", async () => {
    const parts = vi.fn();
    const controller = new ContractsController({
      detail: vi.fn().mockRejectedValue(new Error("denied")),
    } as never);
    await expect(
      controller.upload("contract", hr, { parts } as never),
    ).rejects.toThrow("denied");
    expect(parts).not.toHaveBeenCalled();
  });
});

// Explicit opt-in for a disposable MariaDB database only; never reads root .env.
const databaseUrl = process.env.EDO_CONTRACT_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("signing lifecycle on isolated MariaDB", () => {
  const db = new PrismaClient({
    datasources: { db: { url: databaseUrl ?? "mysql://unused@127.0.0.1/edo" } },
  });
  const binaries = new Map<string, Buffer>();
  const storage = {
    uploadBuffer: vi.fn(async (key: string, bytes: Buffer) => {
      binaries.set(key, bytes);
    }),
    delete: vi.fn(async (key: string) => {
      binaries.delete(key);
    }),
    previewUrl: vi.fn(
      async (key: string) => `https://files.test/${key}?preview`,
    ),
    downloadUrl: vi.fn(
      async (key: string) => `https://files.test/${key}?download`,
    ),
  };
  const audit = new AuditService(db as never);
  const objects = new ContractObjectsService(
    db as never,
    storage as never,
    audit,
  );
  const zup = {
    types: vi.fn(async () => [
      {
        code: "general",
        name: "Договор",
        source_object: "Справочник.Сотрудники",
      },
    ]),
    generate: vi.fn<() => Promise<Buffer>>(),
  };
  const service = new ContractsService(
    db as never,
    audit,
    storage as never,
    zup as never,
    new ContractFileService(new ConfigService()),
    objects,
  );
  let pdf: Buffer;
  let candidateId: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      ["12002", "3306", ""].includes(url.port) ||
      url.pathname !== "/edo"
    )
      throw new Error(
        "Only an isolated local MariaDB on a nonstandard port/database edo is allowed",
      );
    const document = await PDFDocument.create();
    document.addPage();
    pdf = Buffer.from(await document.save());
    await db.$connect();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.signingContractNotification.deleteMany();
    await db.signingContractConfirmation.deleteMany();
    await db.signingContractVersion.deleteMany();
    await db.signingContract.deleteMany();
    await db.signingContractObject.deleteMany();
    await db.auditLog.deleteMany();
    await db.candidate.deleteMany();
    binaries.clear();
    const candidate = await db.candidate.create({
      data: {
        identityKey: "test-contract",
        code1c: employee.code1c,
        fullName: "Тестовый Сотрудник",
        birthDate: new Date("1990-04-15T00:00:00Z"),
        citizenship: "uz",
      },
    });
    candidateId = candidate.id;
    zup.generate.mockResolvedValue(pdf);
  });
  afterAll(() => db.$disconnect());
  async function draft() {
    return service.create(
      { candidateId, documentType: "general", requestId: randomUUID() },
      hr,
    );
  }
  async function pending() {
    const created = await draft();
    return service.send(created.id, action(created.revision), hr);
  }

  it("generates the exact ZUP identity payload and preserves original PDF bytes", async () => {
    const body = {
      candidateId,
      documentType: "general",
      requestId: randomUUID(),
    };
    const created = await service.create(body, hr);
    expect(zup.generate).toHaveBeenLastCalledWith({
      full_name: "Тестовый Сотрудник",
      birth_date: "15.04.1990",
      document_type: "general",
    });
    expect(created.status).toBe("DRAFT");
    const version = await db.signingContractVersion.findFirstOrThrow({
      where: { contractId: created.id },
    });
    expect(binaries.get(version.storageKey)).toEqual(pdf);
    expect((await service.create(body, hr)).id).toBe(created.id);
    expect(await db.signingContract.count()).toBe(1);
  });
  it("completes employer-first signing and archives the same hash with one notification", async () => {
    const sent = await pending();
    expect(sent.confirmations.map((c) => c.role)).toEqual(["employer"]);
    const body = { ...action(sent.revision), bank: ContractBank.SBER };
    const complete = await service.confirm(sent.id, body, employee);
    expect(complete.status).toBe("COMPLETED");
    expect(complete.confirmations.map((c) => c.role)).toEqual([
      "employer",
      "employee",
    ]);
    expect(new Set(complete.confirmations.map((c) => c.sha256)).size).toBe(1);
    const stored = await db.signingContract.findUniqueOrThrow({
      where: { id: sent.id },
    });
    const journal = JSON.parse(binaries.get(stored.journalKey!)!.toString());
    expect(journal.mode).toBe("demo");
    expect(journal.confirmations).toHaveLength(2);
    expect((await service.confirm(sent.id, body, employee)).id).toBe(sent.id);
    expect((await service.notifications(hr)).items).toHaveLength(1);
    expect(
      await db.auditLog.count({ where: { action: "CONTRACT_CONFIRMED" } }),
    ).toBe(1);
  });
  it("allows only the frozen owner and never exposes drafts through own APIs", async () => {
    const created = await draft();
    await expect(service.detail(created.id, employee, true)).rejects.toThrow(
      "Договор не найден",
    );
    const sent = await service.send(created.id, action(created.revision), hr);
    await expect(service.detail(sent.id, outsider, true)).rejects.toThrow(
      "Договор не найден",
    );
    await db.candidate.update({
      where: { id: candidateId },
      data: { code1c: outsider.code1c },
    });
    expect((await service.detail(sent.id, employee, true)).id).toBe(sent.id);
    await expect(service.detail(sent.id, outsider, true)).rejects.toThrow();
  });
  it("blocks sending without a linked employee, but allows manual preparation", async () => {
    await db.candidate.update({
      where: { id: candidateId },
      data: { code1c: null },
    });
    const manual = await service.create(
      {
        candidateId,
        documentType: "manual",
        requestId: randomUUID(),
        manual: true,
      },
      hr,
    );
    const uploaded = await service.upload(
      manual.id,
      action(manual.revision),
      pdf,
      "own.pdf",
      hr,
    );
    await expect(
      service.send(uploaded.id, action(uploaded.revision), hr),
    ).rejects.toThrow("code1c");
    expect((await service.detail(manual.id, hr)).status).toBe("DRAFT");
  });
  it("rejects replacement after send and stale draft revisions", async () => {
    const created = await draft();
    await expect(
      service.upload(created.id, action(0), pdf, "own.pdf", hr),
    ).rejects.toThrow("изменился");
    const sent = await service.send(created.id, action(created.revision), hr);
    await expect(
      service.upload(sent.id, action(sent.revision), pdf, "own.pdf", hr),
    ).rejects.toThrow("изменился");
  });
  it("settles concurrent employer replays exactly once", async () => {
    const created = await draft();
    const body = action(created.revision);
    const results = await Promise.all([
      service.send(created.id, body, hr),
      service.send(created.id, body, hr),
    ]);
    expect(results.every((r) => r.status === "WAITING_EMPLOYEE")).toBe(true);
    expect(await db.signingContractConfirmation.count()).toBe(1);
  });
  it("settles concurrent employee replays exactly once", async () => {
    const sent = await pending();
    const body = { ...action(sent.revision), bank: ContractBank.T };
    const results = await Promise.all([
      service.confirm(sent.id, body, employee),
      service.confirm(sent.id, body, employee),
    ]);
    expect(results.every((r) => r.status === "COMPLETED")).toBe(true);
    expect(await db.signingContractNotification.count()).toBe(1);
  });
  it("rolls back state, confirmation and notification when audit fails", async () => {
    const sent = await pending();
    vi.spyOn(audit, "logInTransaction").mockRejectedValueOnce(
      new Error("audit offline"),
    );
    await expect(
      service.confirm(
        sent.id,
        { ...action(sent.revision), bank: ContractBank.ALFA },
        employee,
      ),
    ).rejects.toThrow("audit offline");
    expect((await service.detail(sent.id, employee, true)).status).toBe(
      "WAITING_EMPLOYEE",
    );
    expect(await db.signingContractConfirmation.count()).toBe(1);
    expect(await db.signingContractNotification.count()).toBe(0);
  });
  it("leaves an existing version intact when S3 replacement fails", async () => {
    const created = await draft();
    vi.spyOn(storage, "uploadBuffer").mockRejectedValueOnce(
      new Error("storage offline"),
    );
    await expect(
      service.upload(
        created.id,
        action(created.revision),
        pdf,
        "replacement.pdf",
        hr,
      ),
    ).rejects.toThrow("storage offline");
    expect((await service.detail(created.id, hr)).version).toBe(1);
  });
  it("does not claim completion when the journal cannot be saved", async () => {
    const sent = await pending();
    vi.spyOn(storage, "uploadBuffer").mockRejectedValueOnce(
      new Error("storage offline"),
    );
    await expect(
      service.confirm(
        sent.id,
        { ...action(sent.revision), bank: ContractBank.T },
        employee,
      ),
    ).rejects.toThrow("storage offline");
    expect((await service.detail(sent.id, employee, true)).status).toBe(
      "WAITING_EMPLOYEE",
    );
  });
  it("declines once and restricts durable notifications to the sender", async () => {
    const sent = await pending();
    const body = action(sent.revision);
    expect((await service.decline(sent.id, body, employee)).status).toBe(
      "DECLINED",
    );
    expect((await service.decline(sent.id, body, employee)).status).toBe(
      "DECLINED",
    );
    const notification = (await service.notifications(hr)).items[0];
    await expect(
      service.readNotification(
        notification.id,
        user("other-hr", hr.accessRules),
      ),
    ).rejects.toThrow();
    expect(
      (await service.readNotification(notification.id, hr)).readAt,
    ).not.toBeNull();
    await expect(
      service.confirm(
        sent.id,
        { ...action(3), bank: ContractBank.T },
        employee,
      ),
    ).rejects.toThrow();
  });
  it("cleans expired orphans and fences adoption after cleanup claim", async () => {
    const staged = await objects.stage(
      "orphan",
      "doc.pdf",
      pdf,
      "application/pdf",
    );
    await db.signingContractObject.update({
      where: { key: staged },
      data: { cleanupClaimed: true },
    });
    await expect(
      db.$transaction((tx) => objects.retain(tx, [staged])),
    ).rejects.toThrow("истёк");
    await db.signingContractObject.update({
      where: { key: staged },
      data: { createdAt: new Date(Date.now() - 7_200_000) },
    });
    await objects.cleanup();
    expect(binaries.has(staged)).toBe(false);
    expect(await db.signingContractObject.count()).toBe(0);
  });
  it("keeps private integration error details out of failed draft metadata", async () => {
    zup.generate.mockRejectedValueOnce(new Error("credential=DO_NOT_EXPOSE"));
    await expect(draft()).rejects.toThrow("DO_NOT_EXPOSE");
    const failed = (await service.list(hr)).items[0];
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).not.toContain("DO_NOT_EXPOSE");
  });
});

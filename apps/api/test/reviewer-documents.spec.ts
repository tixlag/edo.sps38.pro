import { describe, expect, it, vi } from "vitest";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ReviewerDocumentsService } from "../src/documents/reviewer-documents.service";
import { ReviewerDocumentsController } from "../src/documents/reviewer-documents.controller";
import type { AuthPrincipal } from "../src/auth/auth-principal";

describe("ReviewerDocumentsService & Controller", () => {
  const ruPrincipal = { uuid: "reviewer-ru", accessRules: { "20002": [] } } as unknown as AuthPrincipal;
  const igPrincipal = { uuid: "reviewer-ig", accessRules: { "20011": [] } } as unknown as AuthPrincipal;
  const adminPrincipal = { uuid: "admin", accessRules: { "20009": [] } } as unknown as AuthPrincipal;

  const ruCandidate = {
    id: "c-ru",
    citizenship: "ru",
    erpUid: "erp-cand-1",
    code1c: null,
    personUid: null,
    chatUuid: null,
    positionCode: "pos-1",
    projectCode: "prj-1",
    sexKnown: true,
    sex: "male",
  };

  const igCandidate = {
    id: "c-ig",
    citizenship: "uz",
    erpUid: null,
    code1c: "emp-ig-1",
    personUid: "pers-ig-1",
    chatUuid: null,
    positionCode: "pos-2",
    projectCode: null,
    sexKnown: false,
    sex: null,
  };

  function createService() {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      candidate: {
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({}),
      },
      candidatePreviousDocument: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      candidatePreviousDocumentFieldEdit: {
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
      documentType: {
        findUnique: vi.fn(),
      },
    };

    const prisma = {
      $transaction: vi.fn((cb) => cb(tx)),
      candidatePreviousDocument: {
        findFirst: vi.fn(),
      },
      candidatePreviousDocumentFieldEdit: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      documentType: {
        findUnique: vi.fn(),
      },
      documentVersion: {
        findFirst: vi.fn(),
      },
    };

    const access = {
      candidate: vi.fn(),
    };

    const uploads = {
      parse: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const manual = {
      upload: vi.fn(),
    };

    const catalog = {
      list: vi.fn().mockResolvedValue({ items: [{ code: "PASSPORT", title: "Паспорт" }] }),
    };

    const audit = {
      logInTransaction: vi.fn().mockResolvedValue({}),
    };

    const delivery = {
      request: vi.fn().mockResolvedValue({ status: "PENDING" }),
    };

    const service = new ReviewerDocumentsService(
      prisma as never,
      access as never,
      uploads as never,
      manual as never,
      catalog as never,
      audit as never,
    );

    const controller = new ReviewerDocumentsController(service, delivery as never);

    return { service, controller, prisma, tx, access, uploads, manual, catalog, audit, delivery };
  }

  describe("permissions and direction scopes", () => {
    it("permits RU reviewer on RU candidate and forbids on IG candidate", async () => {
      const { service, access } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      const types = await service.types("c-ru", ruPrincipal);
      expect(types.items).toHaveLength(1);

      access.candidate.mockResolvedValueOnce(igCandidate);
      await expect(service.types("c-ig", ruPrincipal)).rejects.toThrow(ForbiddenException);
    });

    it("permits IG reviewer on IG candidate and forbids on RU candidate", async () => {
      const { service, access } = createService();
      access.candidate.mockResolvedValueOnce(igCandidate);
      const types = await service.types("c-ig", igPrincipal);
      expect(types.items).toHaveLength(1);

      access.candidate.mockResolvedValueOnce(ruCandidate);
      await expect(service.types("c-ru", igPrincipal)).rejects.toThrow(ForbiddenException);
    });

    it("permits admin 20009 on both RU and IG candidates", async () => {
      const { service, access } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      await expect(service.types("c-ru", adminPrincipal)).resolves.toBeDefined();

      access.candidate.mockResolvedValueOnce(igCandidate);
      await expect(service.types("c-ig", adminPrincipal)).resolves.toBeDefined();
    });
  });

  it("requires known citizenship before reviewer types or upload instead of guessing RU",async()=>{
    const {service,access,catalog,uploads}=createService();
    access.candidate.mockResolvedValue({...ruCandidate,reviewGroup:"RU",citizenship:null});
    await expect(service.types("c-ru",ruPrincipal)).rejects.toMatchObject({code:"CANDIDATE_PROFILE_INCOMPLETE",fields:["citizenship"]});
    await expect(service.upload("c-ru",ruPrincipal,{} as never,"request","correlation")).rejects.toMatchObject({code:"CANDIDATE_PROFILE_INCOMPLETE",fields:["citizenship"]});
    expect(catalog.list).not.toHaveBeenCalled();expect(uploads.parse).not.toHaveBeenCalled();
  });
  describe("reviewer upload flow", () => {
    it("requires ERP candidateUid for RU candidates without one", async () => {
      const { service, access } = createService();
      access.candidate.mockResolvedValueOnce({ ...ruCandidate, erpUid: null });
      await expect(
        service.upload("c-ru", ruPrincipal, {} as never, "idemp-1", "corr-1"),
      ).rejects.toThrow(ConflictException);
    });

    it("requires personUid and code1c for IG candidates", async () => {
      const { service, access } = createService();
      access.candidate.mockResolvedValueOnce({ ...igCandidate, personUid: null });
      await expect(
        service.upload("c-ig", igPrincipal, {} as never, "idemp-1", "corr-1"),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects pre-supplied metadata in multipart upload", async () => {
      const { service, access, uploads } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      uploads.parse.mockResolvedValueOnce({
        documentTypeCode: "PASSPORT",
        metadata: { position_code_1c: "pos" },
      });
      await expect(
        service.upload("c-ru", ruPrincipal, {} as never, "idemp-1", "corr-1"),
      ).rejects.toThrow(BadRequestException);
      expect(uploads.dispose).toHaveBeenCalled();
    });

    it("populates metadata from server catalog and delegates to manual upload with reviewer context", async () => {
      const { service, access, uploads, prisma, manual } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      uploads.parse.mockResolvedValueOnce({
        documentTypeCode: "PASSPORT",
        idempotencyKey: "multipart-key",
      });
      prisma.documentType.findUnique.mockResolvedValueOnce({
        code: "PASSPORT",
        erpUid: "doc-type-erp-uid",
      });
      manual.upload.mockResolvedValueOnce({ documentId: "doc-1", version: 1 });

      const res = await service.upload("c-ru", ruPrincipal, {} as never, undefined, "corr-1");
      expect(res).toEqual({ documentId: "doc-1", version: 1 });
      expect(manual.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            documentUid: "doc-type-erp-uid",
            position_code_1c: "pos-1",
            citizenship: "ru",
            project_code_1c: "prj-1",
          }),
        }),
        "multipart-key",
        "corr-1",
        { candidateId: "c-ru", principal: ruPrincipal },
      );
      expect(uploads.dispose).toHaveBeenCalled();
    });
  });

  describe("previous documents details and edits", () => {
    it("returns details with fields, original and edited values", async () => {
      const { service, access, prisma } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      prisma.candidatePreviousDocument.findFirst.mockResolvedValueOnce({
        id: "prev-1",
        candidateId: "c-ru",
        documentUid: "type-uid-1",
        title: "Паспорт",
        fields: { series: "1234", number: "567890" },
        erpFields: { series: "1234", number: "000000" },
        localRevision: 3,
        fieldEdits: [{ name: "number", value: "567890", editedBy: "reviewer-ru" }],
        originalAvailable: true,
        expiresAt: null,
      });
      prisma.documentType.findUnique.mockResolvedValueOnce({
        code: "PASSPORT",
        definitions: [
          { name: "series", kind: "text", required: true, ordinal: 0 },
          { name: "number", kind: "text", required: true, ordinal: 1 },
        ],
      });

      const details = await service.details("c-ru", "prev-1", ruPrincipal);
      expect(details.revision).toBe(3);
      expect(details.hasLocalEdits).toBe(true);
      expect(details.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "number",
            value: "567890",
            originalValue: "000000",
            edited: true,
            editedBy: "reviewer-ru",
          }),
          expect.objectContaining({
            name: "series",
            value: "1234",
            originalValue: "1234",
            edited: false,
          }),
        ]),
      );
    });

    it("rejects edit if revision does not match current localRevision", async () => {
      const { service, access, tx } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      tx.candidate.findFirst.mockResolvedValueOnce(ruCandidate);
      tx.candidatePreviousDocument.findFirst.mockResolvedValueOnce({
        id: "prev-1",
        candidateId: "c-ru",
        localRevision: 2,
        fields: {},
        erpFields: {},
        fieldEdits: [],
      });

      await expect(
        service.edit(
          "c-ru",
          "prev-1",
          { revision: 1, fields: { number: "123456" } },
          ruPrincipal,
          "corr-1",
        ),
      ).rejects.toThrow(ConflictException);
    });

    it("saves field edit locally, updates effective fields, updates expiry, increments revision and audits", async () => {
      const { service, access, tx, prisma } = createService();
      access.candidate.mockResolvedValue(ruCandidate);
      tx.candidate.findFirst.mockResolvedValue(ruCandidate);
      tx.candidatePreviousDocument.findFirst.mockResolvedValue({
        id: "prev-1",
        candidateId: "c-ru",
        localRevision: 2,
        fields: { number: "old-num", expiryDate: "2025-01-01" },
        erpFields: { number: "old-num", expiryDate: "2025-01-01" },
        documentUid: "type-uid-1",
        title: "Паспорт",
        fieldEdits: [],
        originalAvailable: true,
      });
      tx.documentType.findUnique.mockResolvedValue({
        code: "PASSPORT",
        definitions: [
          { name: "number", kind: "text", required: true, ordinal: 0 },
          { name: "expiryDate", kind: "date", required: false, ordinal: 1 },
        ],
      });
      tx.candidatePreviousDocumentFieldEdit.findMany.mockResolvedValue([
        { name: "number", value: "new-num", kind: "text", editedBy: "reviewer-ru" },
        { name: "expiryDate", value: "2030-12-31", kind: "date", editedBy: "reviewer-ru" },
      ]);
      prisma.candidatePreviousDocument.findFirst.mockResolvedValue({
        id: "prev-1",
        candidateId: "c-ru",
        localRevision: 3,
        fields: { number: "new-num", expiryDate: "2030-12-31" },
        erpFields: { number: "old-num", expiryDate: "2025-01-01" },
        fieldEdits: [
          { name: "number", value: "new-num", kind: "text", editedBy: "reviewer-ru" },
          { name: "expiryDate", value: "2030-12-31", kind: "date", editedBy: "reviewer-ru" },
        ],
        documentUid: "type-uid-1",
        title: "Паспорт",
        originalAvailable: true,
      });
      prisma.documentType.findUnique.mockResolvedValue({
        code: "PASSPORT",
        definitions: [
          { name: "number", kind: "text", required: true, ordinal: 0 },
          { name: "expiryDate", kind: "date", required: false, ordinal: 1 },
        ],
      });

      await service.edit(
        "c-ru",
        "prev-1",
        { revision: 2, fields: { number: "new-num", expiryDate: "2030-12-31" } },
        ruPrincipal,
        "corr-1",
      );

      expect(tx.candidatePreviousDocumentFieldEdit.upsert).toHaveBeenCalledTimes(2);
      expect(tx.candidatePreviousDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prev-1" },
          data: expect.objectContaining({
            localRevision: { increment: 1 },
            expiresAt: new Date("2030-12-31T00:00:00Z"),
          }),
        }),
      );
    });
  });

  describe("controller retry reviewer delivery", () => {
    it("checks delivery version is a reviewer submission and delegates to delivery.request", async () => {
      const { controller, access, prisma, delivery } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      prisma.documentVersion.findFirst.mockResolvedValueOnce({
        id: "v-1",
        documentId: "doc-1",
        version: 1,
      });

      await controller.retry("c-ru", "doc-1", 1, ruPrincipal, { correlationId: "corr-1" });
      expect(delivery.request).toHaveBeenCalledWith("doc-1", 1, ruPrincipal, "corr-1");
    });

    it("rejects retry when document was not uploaded by reviewer", async () => {
      const { controller, access, prisma } = createService();
      access.candidate.mockResolvedValueOnce(ruCandidate);
      prisma.documentVersion.findFirst.mockResolvedValueOnce(null);

      await expect(
        controller.retry("c-ru", "doc-1", 1, ruPrincipal, { correlationId: "corr-1" }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

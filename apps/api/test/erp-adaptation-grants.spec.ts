import { describe, expect, it, vi } from "vitest";
import { ErpAdaptationGrantsController } from "../src/documents/erp-adaptation-grants.controller";
import { IgEmploymentService } from "../src/documents/ig-employment.service";
import { CandidatePreviousDocumentsSyncService } from "../src/documents/candidate-previous-documents-sync.service";
import { LkInternalGuard } from "../src/documents/lk-internal.guard";
import { AdaptationGrantsDto } from "../src/documents/erp-adaptation-grants.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ConflictException } from "@nestjs/common";

describe("ErpAdaptationGrantsController", () => {
  const createMockService = () => ({
    applyGrant: vi.fn(),
  });

  const createMockSync = () => ({
    syncPreviousDocuments: vi.fn().mockResolvedValue(undefined),
  });

  it("applies a single adaptation grant and triggers previous documents sync", async () => {
    const service = createMockService();
    service.applyGrant.mockResolvedValue("candidate-1");
    const sync = createMockSync();

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
      sync as unknown as CandidatePreviousDocumentsSyncService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: true,
        },
      ],
    });

    expect(result).toEqual({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          applied: true,
          known: true,
        },
      ],
    });

    expect(service.applyGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "УП00035198",
        citizenship: "UZ",
        personUid: "00000000-0000-4000-8000-000000000001",
        enabled: true,
      }),
    );
    expect(sync.syncPreviousDocuments).toHaveBeenCalledWith(
      "candidate-1",
      "system:adaptation",
      "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
    );
  });

  it("processes batch items independently when one succeeds and another encounters an identity mismatch", async () => {
    const service = createMockService();
    service.applyGrant
      .mockResolvedValueOnce("candidate-1")
      .mockRejectedValueOnce(
        new ConflictException("ERP_PERSON_IDENTITY_MISMATCH"),
      );

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce1",
          code1c: "УП00000001",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: true,
        },
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce2",
          code1c: "УП00000002",
          personUid: "00000000-0000-4000-8000-000000000002",
          citizenship: "UZ",
          enabled: true,
        },
      ],
    });

    expect(result).toEqual({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce1",
          code1c: "УП00000001",
          applied: true,
          known: true,
        },
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce2",
          code1c: "УП00000002",
          applied: false,
          known: false,
        },
      ],
    });
  });

  it("handles repeated delivery safely (idempotent repeat)", async () => {
    const service = createMockService();
    service.applyGrant.mockResolvedValue("candidate-1");

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const item = {
      operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      code1c: "УП00035198",
      personUid: "00000000-0000-4000-8000-000000000001",
      citizenship: "UZ",
      enabled: true,
    };

    const first = await controller.apply({ items: [item] });
    const second = await controller.apply({ items: [item] });

    expect(first.items[0]).toEqual({
      operationId: item.operationId,
      code1c: item.code1c,
      applied: true,
      known: true,
    });
    expect(second.items[0]).toEqual({
      operationId: item.operationId,
      code1c: item.code1c,
      applied: true,
      known: true,
    });
  });

  it("marks item as not applied when operationId conflicts with different code1c", async () => {
    const service = createMockService();
    service.applyGrant.mockRejectedValue(
      new ConflictException("IG_GRANT_EVENT_CONFLICT"),
    );

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00099999",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: true,
        },
      ],
    });

    expect(result.items[0]).toEqual({
      operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      code1c: "УП00099999",
      applied: false,
      known: false,
    });
  });

  it("handles enabled=false safely without failing", async () => {
    const service = createMockService();
    service.applyGrant.mockResolvedValue("candidate-1");

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: false,
        },
      ],
    });

    expect(result.items[0]).toEqual({
      operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      code1c: "УП00035198",
      applied: true,
      known: true,
    });
  });

  describe("guard and validation contracts", () => {
    it("is protected by LkInternalGuard requiring Bearer token matching EDO_LK_INTERNAL_TOKEN", () => {
      const guard = new LkInternalGuard({
        get: (k: string) =>
          k === "EDO_LK_INTERNAL_TOKEN" ? "secret-s2s-token" : undefined,
      } as any);

      const context = (authorization?: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({ headers: { authorization } }),
          }),
        }) as any;

      expect(() => guard.canActivate(context())).toThrow();
      expect(() => guard.canActivate(context("Bearer wrong-token"))).toThrow();
      expect(guard.canActivate(context("Bearer secret-s2s-token"))).toBe(true);
    });

    it("validates DTO structure strictly", async () => {
      const empty = plainToInstance(AdaptationGrantsDto, { items: [] });
      const emptyErrors = await validate(empty);
      expect(emptyErrors.length).toBeGreaterThan(0);

      const invalidItem = plainToInstance(AdaptationGrantsDto, {
        items: [
          {
            operationId: "not-a-uuid",
            code1c: "",
            personUid: "also-not-a-uuid",
            citizenship: "",
            enabled: "not-a-boolean",
          },
        ],
      });
      const itemErrors = await validate(invalidItem);
      expect(itemErrors.length).toBeGreaterThan(0);

      const valid = plainToInstance(AdaptationGrantsDto, {
        items: [
          {
            operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
            code1c: "УП00035198",
            personUid: "00000000-0000-4000-8000-000000000001",
            citizenship: "UZ",
            enabled: true,
          },
        ],
      });
      const validErrors = await validate(valid);
      expect(validErrors.length).toBe(0);
    });
  });
});

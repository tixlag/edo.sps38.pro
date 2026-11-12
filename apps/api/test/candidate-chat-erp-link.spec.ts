import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import { EdoAccessRule } from "../src/auth/edo-access-rule";
import { resolveCandidateIdentity } from "../src/documents/candidate-identity";

describe("Candidate ERP linking & auto-healing", () => {
  it("resolveCandidateIdentity merges an empty catalog ghost into the real chat candidate", async () => {
    const chatUuid = "01a1a9d5-a8da-7dcb-af7e-a8d18bb3fe52";
    const erpUid = "4a44b6b7-f900-45da-be2e-e376fbe15d1c";

    const ghostCandidate = {
      id: "ghost-1",
      erpUid,
      chatUuid: null,
      identityKey: `erp-candidate:${erpUid}`,
      statusId: "Заезд",
      statusName: "Заезд/выход",
      managerId: "mgr-1",
      managerName: "Менеджер",
      projectCode: "PROJ-1",
      projectName: "Проект 1",
      positionCode: "000000013",
      positionName: "Машинист экскаватора",
      reviewGroup: "RU",
      _count: { documents: 0, previousDocuments: 0 },
    };

    const realCandidate = {
      id: "real-1",
      erpUid: null,
      chatUuid,
      identityKey: `chat:${chatUuid}`,
      fullName: "Хисматулин Виктор Эдуардович",
      statusId: null,
      statusName: null,
      managerId: null,
      managerName: null,
      projectCode: "PROJ-1",
      projectName: "Проект 1",
      positionCode: "000000013",
      positionName: "Машинист экскаватора",
      reviewGroup: null,
      _count: { documents: 5, previousDocuments: 0 },
    };

    const tx = {
      candidate: {
        findMany: vi.fn().mockResolvedValue([ghostCandidate, realCandidate]),
        delete: vi.fn().mockResolvedValue(ghostCandidate),
        update: vi.fn().mockImplementation(({ where, data }) => ({
          ...realCandidate,
          ...data,
        })),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    const result = await resolveCandidateIdentity(tx as any, {
      chatUuid,
      erpUid,
      identityKey: `chat:${chatUuid}`,
      reviewGroup: "RU",
    });

    expect(tx.candidate.delete).toHaveBeenCalledWith({
      where: { id: "ghost-1" },
    });
    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "real-1" },
        data: expect.objectContaining({
          erpUid,
          statusId: "Заезд",
          reviewGroup: "RU",
        }),
      }),
    );
    expect(result.id).toBe("real-1");
    expect(result.erpUid).toBe(erpUid);
  });

  it("CandidateWorkspaceService auto-heals missing erpUid from ERP candidate client", async () => {
    const chatUuid = "01a1a9d5-a8da-7dcb-af7e-a8d18bb3fe52";
    const erpUid = "4a44b6b7-f900-45da-be2e-e376fbe15d1c";

    const principal: AuthPrincipal = {
      uuid: "reviewer-1",
      sid: "sid-1",
      code1c: "HR001",
      accessRules: { [EdoAccessRule.DOCUMENT_REVIEW_RU]: [] },
    };

    const unlinkedRow = {
      id: "cand-1",
      chatUuid,
      erpUid: null,
      citizenship: "ru",
      reviewGroup: null,
      code1c: null,
    };

    const updatedRow = {
      ...unlinkedRow,
      erpUid,
      reviewGroup: "RU",
      code1c: "УП00040536",
    };

    const access = {
      candidate: vi.fn().mockResolvedValue(unlinkedRow),
    };

    const candidates = {
      findByChatUuid: vi.fn().mockResolvedValue({
        erpUid,
        code1c: "УП00040536",
        uuid: chatUuid,
      }),
    };

    const tx = {
      candidate: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue(updatedRow),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    const prisma = {
      $transaction: vi.fn().mockImplementation(async (cb) => cb(tx)),
    };

    const audit = {
      logInTransaction: vi.fn().mockResolvedValue(undefined),
    };

    const erp = {
      card: vi.fn().mockResolvedValue({ erpUid }),
    };

    const service = new CandidateWorkspaceService(
      prisma as any,
      erp as any,
      access as any,
      audit as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      candidates as any,
    );

    // Call private owner via (service as any).owner
    const result = await (service as any).owner("cand-1", principal);

    expect(candidates.findByChatUuid).toHaveBeenCalledWith(chatUuid);
    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-1" },
        data: expect.objectContaining({
          erpUid,
          reviewGroup: "RU",
          code1c: "УП00040536",
        }),
      }),
    );
    expect(result.erpUid).toBe(erpUid);
  });

  it("CandidateWorkspaceService auto-heals and transfers ghost catalog metadata", async () => {
    const chatUuid = "01a1a9d5-a8da-7dcb-af7e-a8d18bb3fe52";
    const erpUid = "4a44b6b7-f900-45da-be2e-e376fbe15d1c";

    const principal: AuthPrincipal = {
      uuid: "reviewer-1",
      sid: "sid-1",
      code1c: "HR001",
      accessRules: { [EdoAccessRule.DOCUMENT_REVIEW_RU]: [] },
    };

    const realRow = {
      id: "real-1",
      chatUuid,
      erpUid: null,
      citizenship: "ru",
      reviewGroup: null,
      code1c: null,
      statusId: null,
      managerId: null,
    };

    const ghostRow = {
      id: "ghost-1",
      erpUid,
      chatUuid: null,
      statusId: "status-test",
      managerId: "mgr-test",
      _count: { documents: 0, previousDocuments: 0 },
    };

    const access = {
      candidate: vi.fn().mockResolvedValue(realRow),
    };

    const candidates = {
      resolveIdentityByChat: vi.fn().mockResolvedValue(erpUid),
      findByChatUuid: vi.fn().mockResolvedValue({
        erpUid,
        code1C: "УП00040536",
        uuid: chatUuid,
      }),
    };

    const tx = {
      candidate: {
        findFirst: vi.fn().mockResolvedValue(ghostRow),
        delete: vi.fn().mockResolvedValue(ghostRow),
        update: vi.fn().mockImplementation(({ where, data }) => ({
          ...realRow,
          ...data,
        })),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    const prisma = {
      $transaction: vi.fn().mockImplementation(async (cb) => cb(tx)),
    };

    const audit = {
      logInTransaction: vi.fn().mockResolvedValue(undefined),
    };

    const service = new CandidateWorkspaceService(
      prisma as any,
      {} as any,
      access as any,
      audit as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      candidates as any,
    );

    const result = await (service as any).owner("real-1", principal);

    expect(tx.candidate.delete).toHaveBeenCalledWith({
      where: { id: "ghost-1" },
    });
    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "real-1" },
        data: expect.objectContaining({
          erpUid,
          reviewGroup: "RU",
          code1c: "УП00040536",
          statusId: "status-test",
          managerId: "mgr-test",
        }),
      }),
    );
    expect(result.erpUid).toBe(erpUid);
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: "CANDIDATE_LINKED",
        entityId: "real-1",
      }),
    );
  });
});

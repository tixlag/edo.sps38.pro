import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import { CommunicationsService } from "../src/communications/communications.service";
import {
  ChatChannel,
  SendCommunicationDto,
} from "../src/communications/communications.dto";
import { CommunicationSourceError } from "../src/communications/erp-communications.client";
import {
  signAttachment,
  verifyAttachment,
} from "../src/communications/chat-attachment-token";
import {
  mergeMessages,
  erpCatalogSchema,
  erpHistorySchema,
} from "../src/communications/communication-contract";

const candidateId = "candidate-1";
const chatUuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
const principal: AuthPrincipal = {
  uuid: "reviewer",
  code1c: "EMP01",
  accessRules: { "20000": [], "20002": [], "20007": ["98"] },
  sid: null,
  deviceId: null,
  expiresAt: null,
};
const input: SendCommunicationDto = {
  requestId: "463b4dfc-5b53-4dbd-a774-9460fae562e3",
  channel: ChatChannel.SMS,
  recipientId: "79990000000@СМС",
  text: "Здравствуйте",
};
const candidate = {
  id: candidateId,
  erpUid: "796f7bb9-caf4-43f2-b5ab-c52bc6e94899",
  chatUuid,
  erpDeleted: false,
  locationId: 98,
};
function setup() {
  let saved: Record<string, unknown> | null = null;
  const prisma = {
    communicationOperation: {
      findUnique: vi.fn(async () => saved),
      findFirst: vi.fn(async () => saved),
      create: vi.fn(
        async ({ data }: { data: Record<string, unknown> }) =>
          (saved = {
            ...data,
            id: "afe2fb65-4dd0-48e1-841c-f642b29fd534",
            status: "PENDING",
            providerId: null,
            errorCode: null,
            createdAt: new Date(),
          }),
      ),
      update: vi.fn(
        async ({ data }: { data: Record<string, unknown> }) =>
          (saved = { ...saved, ...data }),
      ),
    },
    communicationAttachment: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma),
    ),
  };
  const access = { candidate: vi.fn(async () => candidate) };
  const erp = {
    context: vi.fn(async () => ({
      recipients: [
        {
          id: input.recipientId,
          channel: "sms",
          label: "+79990000000",
          supportsFiles: false,
        },
      ],
      templates: [],
    })),
    send: vi.fn(async () => ({
      status: "SENT",
      providerId: "provider-1",
      errorCode: null,
    })),
    history: vi.fn(async () => ({ items: [], nextCursor: null })),
    attachment: vi.fn(),
    link: vi.fn(),
  };
  const lk = {
    configured: () => true,
    history: vi.fn(async () => ({ items: [], hasMore: false })),
    sendText: vi.fn(async () => "lk-message"),
    sendFile: vi.fn(),
    download: vi.fn(),
  };
  const audit = { logInTransaction: vi.fn(async () => undefined) };
  const storage = {
    read: vi.fn(),
    uploadBuffer: vi.fn(async () => undefined),
    delete: vi.fn(),
    downloadUrl: vi.fn(async () => "https://s3/download"),
  };
  const redis = {
    setNxPxStrict: vi.fn(async () => true),
    compareAndDelStrict: vi.fn(async () => true),
  };
  const service = new CommunicationsService(
    prisma as never,
    access as never,
    erp as never,
    lk as never,
    audit as never,
    storage as never,
    new ConfigService({ JWT_SECRET: "test-secret" }),
    redis as never,
  );
  return { service, prisma, access, erp, lk, audit, storage, redis };
}
describe("candidate communications", () => {
  it("sends SMS as the verified actor, persists request and receipt with atomic audit, and replays without another send", async () => {
    const s = setup();
    expect(await s.service.send(candidateId, principal, input)).toMatchObject({
      status: "SENT",
      providerId: "provider-1",
    });
    expect(s.erp.send).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "EMP01",
        candidate: candidate.erpUid,
        channel: "sms",
        recipientId: input.recipientId,
      }),
    );
    await s.service.send(candidateId, principal, input);
    expect(s.erp.send).toHaveBeenCalledTimes(1);
    expect(s.audit.logInTransaction).toHaveBeenCalledTimes(2);
    expect(s.prisma.$transaction).toHaveBeenCalledTimes(2);
    await expect(
      s.service.send(candidateId, principal, {
        ...input,
        text: "Другое сообщение",
      }),
    ).rejects.toThrow("Ключ отправки");
  });
  it("keeps an uncertain provider result and never redispatches it on retry", async () => {
    const s = setup();
    s.erp.send.mockRejectedValueOnce(
      new CommunicationSourceError("ERP_CHAT_TIMEOUT", true),
    );
    expect(await s.service.send(candidateId, principal, input)).toMatchObject({
      status: "UNKNOWN",
      errorCode: "ERP_CHAT_TIMEOUT",
    });
    await s.service.send(candidateId, principal, input);
    expect(s.erp.send).toHaveBeenCalledTimes(1);
  });
  it("does not send anything when audit fails before dispatch", async () => {
    const s = setup();
    s.audit.logInTransaction.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    await expect(s.service.send(candidateId, principal, input)).rejects.toThrow(
      "audit unavailable",
    );
    expect(s.erp.send).not.toHaveBeenCalled();
  });
  it.each([
    { ...principal, code1c: null },
    { ...principal, accessRules: { "20000": [], "20008": [] } },
    { ...principal, accessRules: { "20002": [], "20008": [] } },
  ])(
    "requires EDO access, review permission and verified code1c for sending",
    async (p) => {
      const s = setup();
      await expect(
        s.service.send(candidateId, p, input),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(s.erp.send).not.toHaveBeenCalled();
    },
  );
  it("honors full access key presence even when its array is empty", async () => {
    const s = setup();
    expect(
      (
        await s.service.context(candidateId, {
          ...principal,
          accessRules: { "20009": [] },
        })
      ).canSend,
    ).toBe(true);
  });
  it("rejects arbitrary recipients and files sent via SMS", async () => {
    const s = setup();
    await expect(
      s.service.send(candidateId, principal, {
        ...input,
        recipientId: "someone-else",
      }),
    ).rejects.toThrow("получатель");
    await expect(
      s.service.send(candidateId, principal, {
        ...input,
        attachmentIds: [chatUuid],
      }),
    ).rejects.toThrow("канал");
    expect(s.erp.send).not.toHaveBeenCalled();
  });
  it("checks scope before reading sources, attachments and operations", async () => {
    const s = setup();
    s.access.candidate.mockRejectedValue(new NotFoundException());
    await expect(
      s.service.history(candidateId, principal),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      s.service.download(candidateId, principal, "forged"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      s.service.operation(candidateId, principal, chatUuid),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(s.erp.history).not.toHaveBeenCalled();
    expect(s.lk.history).not.toHaveBeenCalled();
  });
  it("reads LK even when ERP is unavailable and keeps a retry cursor for the failed source", async () => {
    const s = setup();
    s.erp.history.mockRejectedValue(new Error("offline"));
    const message = {
      id: "lk:1",
      channel: ChatChannel.LK,
      outgoing: false,
      author: "Кандидат",
      createdAt: "2026-10-20T00:00:00.000Z",
      text: "Привет",
      attachments: [],
    };
    s.lk.history.mockResolvedValue({
      items: [message] as never[],
      hasMore: false,
    });
    const result = await s.service.history(candidateId, principal);
    expect(result.items).toEqual([message]);
    expect(result.unavailableSources).toEqual(["erp"]);
    expect(result.nextCursor).not.toBeNull();
  });
  it("does not restart exhausted source pagination", async () => {
    const s = setup();
    const cursor = Buffer.from(JSON.stringify({ erp: null, lk: 50 })).toString(
      "base64url",
    );
    const result = await s.service.history(candidateId, principal, 50, cursor);
    expect(s.erp.history).not.toHaveBeenCalled();
    expect(s.lk.history).toHaveBeenCalledWith(candidateId, chatUuid, 50, 50);
    expect(result.nextCursor).toBeNull();
  });
  it.each([
    "not-json",
    Buffer.from(JSON.stringify({ erp: null, lk: -1 })).toString("base64url"),
  ])("rejects invalid history cursors", async (cursor) => {
    const s = setup();
    await expect(
      s.service.history(candidateId, principal, 50, cursor),
    ).rejects.toThrow("cursor");
  });
  it("cleans an uploaded S3 object when the atomic DB write fails", async () => {
    const s = setup();
    s.prisma.communicationAttachment.create.mockRejectedValueOnce(
      new Error("db offline"),
    );
    await expect(
      s.service.upload(candidateId, principal, {
        filename: "passport.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.from("%PDF-1.7"),
      }),
    ).rejects.toThrow("db offline");
    expect(s.storage.delete).toHaveBeenCalledTimes(1);
  });
});

describe("chat source contract and attachment capabilities", () => {
  it("binds locators to the candidate and rejects tampering before accessing a source", async () => {
    const locator = signAttachment("secret", {
      candidateId,
      source: "lk",
      chatUuid,
      id: "/upload/file.pdf",
      filename: "file.pdf",
      mimeType: "application/pdf",
    });
    expect(verifyAttachment("secret", locator, candidateId).id).toBe(
      "/upload/file.pdf",
    );
    expect(() =>
      verifyAttachment("other-secret", locator, candidateId),
    ).toThrow();
    expect(() =>
      verifyAttachment("secret", locator, "another-candidate"),
    ).toThrow();
    const s = setup();
    await expect(
      s.service.download(candidateId, principal, locator + "x"),
    ).rejects.toThrow();
    expect(s.lk.download).not.toHaveBeenCalled();
  });
  it("deduplicates messages and orders equal timestamps consistently by source ID", () => {
    const a = { id: "lk:1", createdAt: "2026-10-20T00:00:00Z" },
      b = { ...a, id: "erp:1" };
    expect(mergeMessages([a], [b, a])).toEqual([b, a]);
  });
  it("requires explicit end-of-pagination and permits candidates without a chat or position", () => {
    expect(erpCatalogSchema.safeParse({ items: [] }).success).toBe(false);
    expect(erpHistorySchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      erpCatalogSchema.safeParse({
        items: [
          {
            erpUid: chatUuid,
            chatUuid: null,
            fullName: "Кандидат",
            projectCode: null,
            projectName: null,
            positionCode: null,
            positionName: null,
            deleted: false,
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { DocumentReturnNotificationService } from "../src/documents/document-return-notification.service";
import { CommunicationSourceError } from "../src/communications/erp-communications.client";

function fixture(candidate: { chatUuid: string | null; erpUid: string | null }) {
  const operation = {
    id: "operation-1", candidateId: "candidate-1", actorCode1c: "employee-1",
    status: "PENDING", channel: "", recipientId: "", text: "Документ возвращён. Причина: плохое фото",
    candidate,
  };
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    communicationOperation: {
      findUnique: vi.fn().mockResolvedValue(operation),
      updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
        if (where.status !== operation.status) return { count: 0 };
        writes.push(data);
        Object.assign(operation, data);
        return { count: 1 };
      }),
    },
  };
  const erp = { configured: vi.fn().mockReturnValue(false), context: vi.fn(), send: vi.fn() };
  const lk = { configured: vi.fn().mockReturnValue(true), sendText: vi.fn().mockResolvedValue("message-1") };
  const service = new DocumentReturnNotificationService(prisma as never, erp as never, lk as never, {} as never);
  return { operation, writes, prisma, erp, lk, service };
}

describe("candidate document return notification", () => {
  it("sends once through the existing LK channel and records the result", async () => {
    const f = fixture({ chatUuid: "chat-1", erpUid: null });
    await f.service.send("operation-1");
    await f.service.send("operation-1");
    expect(f.lk.sendText).toHaveBeenCalledTimes(1);
    expect(f.lk.sendText).toHaveBeenCalledWith("chat-1", "employee-1", f.operation.text, "operation-1");
    expect(f.operation.status).toBe("SENT");
    expect(f.writes[0]).toMatchObject({ status: "UNKNOWN", errorCode: "SEND_RESULT_UNKNOWN" });
  });

  it("records unavailable channel without changing the document return", async () => {
    const f = fixture({ chatUuid: null, erpUid: null });
    await f.service.send("operation-1");
    expect(f.operation.status).toBe("FAILED");
    expect(f.writes.at(-1)).toMatchObject({ errorCode: "CANDIDATE_CHANNEL_UNAVAILABLE" });
  });

  it("keeps an uncertain LK dispatch from being replayed", async () => {
    const f = fixture({ chatUuid: "chat-1", erpUid: null });
    f.lk.sendText.mockRejectedValueOnce(new CommunicationSourceError("LK_CHAT_TIMEOUT", true));
    await f.service.send("operation-1");
    await f.service.send("operation-1");
    expect(f.operation.status).toBe("UNKNOWN");
    expect(f.lk.sendText).toHaveBeenCalledTimes(1);
  });
});

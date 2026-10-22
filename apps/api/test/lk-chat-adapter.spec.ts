import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { LkChatClient } from "../src/communications/lk-chat.client";
import { verifyAttachment } from "../src/communications/chat-attachment-token";

const { sockets } = vi.hoisted(() => ({
  sockets: [] as {
    url: string;
    options: Record<string, unknown>;
    sent: string[];
    emit: (type: string, ...args: unknown[]) => boolean;
    terminate: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      terminate = vi.fn();
      ping = vi.fn();
      constructor(
        public url: string,
        public options: Record<string, unknown>,
      ) {
        super();
        sockets.push(this);
      }
      send(text: string) {
        this.sent.push(text);
      }
    },
  };
});
const uuid = "463b4dfc-5b53-4dbd-a774-9460fae562e3";
const operation = "796f7bb9-caf4-43f2-b5ab-c52bc6e94899";
const otherOperation = "afe2fb65-4dd0-48e1-841c-f642b29fd534";
const message = {
  uuid: "16165d83-3a36-45bf-9a6b-aa13b741e38b",
  chat_uuid: uuid,
  content: "Test message",
  actor_user_code_1c: "EMP01",
  created_at: "2026-10-20T01:00:00Z",
  member: { member_type_id: 4 },
};
const ack = (operationId = operation, patch = {}) => ({
  action: "send_ack",
  operation_id: operationId,
  status: "SENT",
  message_uuid: message.uuid,
  chat_uuid: uuid,
  actor_user_code_1c: "EMP01",
  error_code: null,
  replayed: false,
  ...patch,
});
const client = () =>
  new LkChatClient(
    new ConfigService({
      LK_CHAT_BASE_URL: "https://chat.example.invalid:8091",
      LK_CANDIDATE_OPERATOR_TOKEN: "test-service-only",
      LK_PUBLIC_BASE_URL: "https://lk.example.invalid",
      JWT_SECRET: "secret",
    }),
  );
const grantResponse = () =>
  new Response(
    JSON.stringify({
      grant: "test-scoped-grant",
      expires_at: new Date(Date.now() + 300000).toISOString(),
    }),
  );
const emit = (socket: (typeof sockets)[number], payload: unknown) =>
  socket.emit("message", Buffer.from(JSON.stringify(payload)));
const history = { action: "history_chat", chat: { uuid, entries: [] } };
async function opened(count = 1) {
  await vi.waitFor(() => expect(sockets).toHaveLength(count));
  return sockets[count - 1];
}
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => grantResponse()),
  ),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sockets.length = 0;
});
describe("LK protected operator protocol adapter", () => {
  it("authorizes read-only history using a server credential and binds the socket to a grant", async () => {
    const promise = client().history("c1", uuid, 50, 100);
    const socket = await opened();
    expect(new URL(socket.url).searchParams.get("offset")).toBe("100");
    expect(socket.options).toMatchObject({
      headers: { Authorization: "Bearer test-scoped-grant" },
      followRedirects: false,
    });
    const request = vi.mocked(fetch).mock.calls[0][1]!;
    expect(JSON.parse(request.body as string)).toEqual({
      chat_uuid: uuid,
      actor_user_code_1c: "",
      can_send: false,
    });
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-service-only",
    });
    emit(socket, {
      ...history,
      chat: {
        uuid,
        entries: [
          {
            message: {
              ...message,
              metadata: {
                url: "/upload/file.pdf",
                original_name: "file.pdf",
                mime: "application/pdf",
                size_bytes: 100,
              },
            },
          },
        ],
      },
    });
    const result = await promise;
    expect(
      verifyAttachment("secret", result.items[0].attachments[0].id, "c1"),
    ).toMatchObject({ chatUuid: uuid, id: "/upload/file.pdf" });
  });
  it("rejects history belonging to another chat", async () => {
    const promise = client().history("c1", uuid, 50, 0);
    const socket = await opened();
    emit(socket, {
      ...history,
      chat: {
        uuid,
        entries: [{ message: { ...message, chat_uuid: message.uuid } }],
      },
    });
    await expect(promise).rejects.toThrow("LK_CHAT_CONTRACT");
  });
  it("uses independent operation acknowledgements for identical text and ignores broadcast", async () => {
    const first = client().sendText(uuid, "EMP01", message.content, operation);
    const second = client().sendText(
      uuid,
      "EMP01",
      message.content,
      otherOperation,
    );
    await opened(2);
    for (const socket of sockets) {
      emit(socket, history);
      emit(socket, { action: "new_entry", entry: { message } });
    }
    expect(JSON.parse(sockets[0].sent[0]).data).toEqual({
      chat_uuid: uuid,
      message: message.content,
      operation_id: operation,
    });
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    emit(sockets[0], ack());
    expect(await first).toBe(message.uuid);
    await Promise.resolve();
    expect(settled).toBe(false);
    emit(sockets[1], ack(otherOperation));
    expect(await second).toBe(message.uuid);
  });
  it.each([
    { chat_uuid: message.uuid },
    { actor_user_code_1c: "OTHER" },
    { operation_id: otherOperation },
  ])("rejects a mismatched ack %j", async (patch) => {
    const promise = client().sendText(
      uuid,
      "EMP01",
      message.content,
      operation,
    );
    const socket = await opened();
    emit(socket, history);
    emit(socket, ack(operation, patch));
    await expect(promise).rejects.toMatchObject({ uncertain: true });
  });
  it("keeps a lost acknowledgement UNKNOWN and does not resend", async () => {
    const promise = client().sendText(
      uuid,
      "EMP01",
      message.content,
      operation,
    );
    const socket = await opened();
    emit(socket, history);
    socket.emit("close");
    await expect(promise).rejects.toMatchObject({ uncertain: true });
    expect(socket.sent).toHaveLength(1);
  });
  it("uses the same ack and operation protocol for files", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(grantResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify(ack())));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await client().sendFile(
        uuid,
        "EMP01",
        "Caption",
        {
          filename: "photo.jpg",
          mimeType: "image/jpeg",
          bytes: Buffer.from("photo"),
        },
        operation,
      ),
    ).toBe(message.uuid);
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe(
      "/candidates/operator/files",
    );
    const request = fetcher.mock.calls[1][1];
    expect(request.headers).toEqual({
      Authorization: "Bearer test-scoped-grant",
    });
    expect(request.body.get("operation_id")).toBe(operation);
    expect(request.body.get("chat_uuid")).toBe(uuid);
  });
  it("rejects a successful HTTP file response without a persisted operation acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(grantResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify(message))),
    );
    await expect(
      client().sendFile(
        uuid,
        "EMP01",
        "",
        {
          filename: "file.pdf",
          mimeType: "application/pdf",
          bytes: Buffer.from("file"),
        },
        operation,
      ),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it("retains explicit provider refusals and replayed confirmations", async () => {
    for (const response of [
      ack(operation, { replayed: true }),
      ack(operation, {
        status: "FAILED",
        message_uuid: null,
        error_code: "OPERATION_CONFLICT",
      }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(grantResponse())
          .mockResolvedValueOnce(new Response(JSON.stringify(response))),
      );
      const promise = client().sendFile(
        uuid,
        "EMP01",
        "",
        {
          filename: "file.pdf",
          mimeType: "application/pdf",
          bytes: Buffer.from("file"),
        },
        operation,
      );
      if (response.status === "SENT") expect(await promise).toBe(message.uuid);
      else
        await expect(promise).rejects.toMatchObject({
          uncertain: false,
          code: "OPERATION_CONFLICT",
        });
    }
  });
  it("disables LK when its service credential is missing", () =>
    expect(
      new LkChatClient(
        new ConfigService({ LK_CHAT_BASE_URL: "https://chat.example.invalid" }),
      ).configured(),
    ).toBe(false));
  it("downloads through LK nginx and rejects other origins and paths", async () => {
    const fetcher = vi.fn(async () => new Response("file"));
    vi.stubGlobal("fetch", fetcher);
    expect((await client().download("/upload/file.pdf")).toString()).toBe(
      "file",
    );
    await expect(
      client().download("https://other.example/upload/file.pdf"),
    ).rejects.toThrow("INVALID");
    await expect(client().download("/api/private")).rejects.toThrow("INVALID");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

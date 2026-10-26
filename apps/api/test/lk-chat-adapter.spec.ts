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
const client = () => new LkChatClient(new ConfigService({
  LK_CHAT_BASE_URL: "https://chat.example.invalid:8091",
  LK_PUBLIC_BASE_URL: "https://lk.example.invalid", JWT_SECRET: "secret",
}));
const emit = (socket: (typeof sockets)[number], payload: unknown) =>
  socket.emit("message", Buffer.from(JSON.stringify(payload)));
const history = { action: "history_chat", chat: { uuid, entries: [] } };
async function opened(count = 1) {
  await vi.waitFor(() => expect(sockets).toHaveLength(count));
  return sockets[count - 1];
}
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); sockets.length = 0; });
describe("LK existing candidate chat protocol", () => {
  it("reads operator history without grants or new server credentials", async () => {
    const promise = client().history("c1", uuid, 50, 100);
    const socket = await opened();
    const url = new URL(socket.url);
    expect(url.pathname).toBe("/ws/candidates/chat");
    expect(url.searchParams.get("offset")).toBe("100");
    expect(url.searchParams.get("candidate_flag")).toBe("false");
    expect(socket.options).not.toHaveProperty("headers");
    expect(fetch).not.toHaveBeenCalled();
    emit(socket, { ...history, chat: { uuid, entries: [{ message: {
      ...message, metadata: { url: "/upload/file.pdf", original_name: "file.pdf", mime: "application/pdf" },
    } }] } });
    const result = await promise;
    expect(verifyAttachment("secret", result.items[0].attachments[0].id, "c1"))
      .toMatchObject({ chatUuid: uuid, id: "/upload/file.pdf" });
  });
  it("rejects history belonging to another chat", async () => {
    const promise = client().history("c1", uuid, 50, 0);
    const socket = await opened();
    emit(socket, { ...history, chat: { uuid, entries: [{ message: { ...message, chat_uuid: message.uuid } }] } });
    await expect(promise).rejects.toThrow("LK_CHAT_CONTRACT");
  });
  it("sends the existing event with the server-verified actor, without an operation protocol", async () => {
    const promise = client().sendText(uuid, "EMP01", message.content, operation);
    const socket = await opened();
    emit(socket, history);
    expect(JSON.parse(socket.sent[0])).toEqual({event: "send_message", data: {
      chat_uuid: uuid, message: message.content, user_code_1c: "EMP01",
    }});
    emit(socket, { action: "new_entry", chat_id: uuid, entry: {message} });
    await expect(promise).resolves.toBe(message.uuid);
  });
  it("does not mistake a historical or unrelated message for the new send", async () => {
    const promise = client().sendText(uuid, "EMP01", message.content, operation);
    const socket = await opened();
    emit(socket, {...history, chat:{uuid, entries:[{message}]}});
    emit(socket, {action:"new_entry", chat_id:uuid, entry:{message}});
    emit(socket, {action:"new_entry", chat_id:uuid, entry:{message:{...message,uuid:otherOperation,actor_user_code_1c:"OTHER"}}});
    socket.emit("close");
    await expect(promise).rejects.toMatchObject({uncertain:true});
    expect(socket.sent).toHaveLength(1);
  });
  it("leaves a lost response uncertain and never resends", async () => {
    const promise = client().sendText(uuid, "EMP01", message.content, operation);
    const socket = await opened();
    emit(socket, history); socket.emit("close");
    await expect(promise).rejects.toMatchObject({uncertain:true});
    expect(socket.sent).toHaveLength(1);
  });
  it("uses the existing file route and validates the saved message", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(message)));
    vi.stubGlobal("fetch",fetcher);
    await expect(client().sendFile(uuid,"EMP01",message.content,{
      filename:"file.pdf",mimeType:"application/pdf",bytes:Buffer.from("file"),
    },operation)).resolves.toBe(message.uuid);
    const [raw,request] = fetcher.mock.calls[0] as unknown as [URL,{headers?: unknown; body: FormData}];
    const url = new URL(raw);
    expect(url.pathname).toBe("/chats/upload/file-message");
    expect(url.searchParams.get("operator_1c")).toBe("true");
    expect(url.searchParams.get("operator_code_1c")).toBe("EMP01");
    expect(request.headers).toBeUndefined();
    expect((request.body as FormData).get("operation_id")).toBeNull();
    expect((request.body as FormData).get("file")).toBeInstanceOf(Blob);
  });
  it.each([new Response("bad",{status:502}), new Response(JSON.stringify({...message,chat_uuid:otherOperation}))])(
    "does not confirm an uncertain or mismatched file response", async response => {
      vi.stubGlobal("fetch",vi.fn(async()=>response));
      await expect(client().sendFile(uuid,"EMP01","",{
        filename:"file.pdf",mimeType:"application/pdf",bytes:Buffer.from("file"),
      },operation)).rejects.toMatchObject({uncertain:true});
    });
  it("enables configured legacy chat without operator secrets", () => {
    expect(client().configured()).toBe(true);
    expect(new LkChatClient(new ConfigService({})).configured()).toBe(false);
  });
  it("downloads through LK nginx and rejects other origins and paths", async () => {
    const fetcher = vi.fn(async()=>new Response("file"));vi.stubGlobal("fetch",fetcher);
    expect((await client().download("/upload/file.pdf")).toString()).toBe("file");
    await expect(client().download("https://other.example/upload/file.pdf")).rejects.toThrow("INVALID");
    await expect(client().download("/api/private")).rejects.toThrow("INVALID");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

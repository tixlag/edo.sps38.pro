import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const message = {
  uuid: "16165d83-3a36-45bf-9a6b-aa13b741e38b",
  chat_uuid: uuid,
  content: "Здравствуйте",
  actor_user_code_1c: "EMP01",
  created_at: "2026-10-20T01:00:00Z",
  member: { member_type_id: 4 },
};
const client = () =>
  new LkChatClient(
    new ConfigService({
      LK_CHAT_BASE_URL: "https://chat.example.invalid:8091",
      LK_PUBLIC_BASE_URL: "https://lk.example.invalid",
      JWT_SECRET: "secret",
    }),
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sockets.length = 0;
});
describe("LK operator protocol adapter", () => {
  it("uses bounded operator history pagination and signs candidate/chat-bound attachment locators", async () => {
    const promise = client().history("c1", uuid, 50, 100);
    const socket = sockets.at(-1)!;
    expect(new URL(socket.url).searchParams.get("offset")).toBe("100");
    expect(socket.options).toMatchObject({
      handshakeTimeout: 10000,
      maxPayload: 2 * 1024 * 1024,
      followRedirects: false,
    });
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          action: "history_chat",
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
        }),
      ),
    );
    const result = await promise;
    expect(result.items[0]).toMatchObject({
      channel: "lk",
      outgoing: true,
      author: "EMP01",
      text: "Здравствуйте",
    });
    expect(
      verifyAttachment("secret", result.items[0].attachments[0].id, "c1"),
    ).toMatchObject({ chatUuid: uuid, id: "/upload/file.pdf" });
    expect(socket.terminate).toHaveBeenCalled();
  });
  it("rejects source messages belonging to another chat", async () => {
    const promise = client().history("c1", uuid, 50, 0);
    sockets.at(-1)!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          action: "history_chat",
          chat: {
            uuid,
            entries: [{ message: { ...message, chat_uuid: message.uuid } }],
          },
        }),
      ),
    );
    await expect(promise).rejects.toThrow("LK_CHAT_CONTRACT");
  });
  it("sends the verified actor code and waits for the matching persisted entry", async () => {
    const promise = client().sendText(uuid, "EMP01", "Здравствуйте");
    const socket = sockets.at(-1)!;
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ action: "history_chat", chat: { uuid, entries: [] } }),
      ),
    );
    expect(JSON.parse(socket.sent[0])).toEqual({
      event: "send_message",
      data: { chat_uuid: uuid, message: "Здравствуйте", user_code_1c: "EMP01" },
    });
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ action: "new_entry", entry: { message } })),
    );
    expect(await promise).toBe(message.uuid);
  });
  it("does not claim success after losing the socket following dispatch", async () => {
    const promise = client().sendText(uuid, "EMP01", "Здравствуйте");
    const socket = sockets.at(-1)!;
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ action: "history_chat", chat: { uuid, entries: [] } }),
      ),
    );
    socket.emit("close");
    await expect(promise).rejects.toMatchObject({ uncertain: true });
    expect(socket.sent).toHaveLength(1);
  });
  it("routes images to the image endpoint, carries the author and preserves the caption", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(message), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await client().sendFile(uuid, "EMP01", "Подпись", {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: Buffer.from("photo"),
      }),
    ).toBe(message.uuid);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/chats/upload/image-message");
    expect(url.searchParams.get("user_id")).toBe("EMP01");
    expect(url.searchParams.get("message")).toBe("Подпись");
  });
  it("downloads through LK nginx and rejects other origins and paths", async () => {
    const fetcher = vi.fn(async () => new Response("file"));
    vi.stubGlobal("fetch", fetcher);
    expect((await client().download("/upload/file.pdf")).toString()).toBe(
      "file",
    );
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://lk.example.invalid/upload/file.pdf",
    );
    await expect(
      client().download("https://other.example/upload/file.pdf"),
    ).rejects.toThrow("INVALID");
    await expect(client().download("/api/private")).rejects.toThrow("INVALID");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

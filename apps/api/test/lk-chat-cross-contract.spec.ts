import "reflect-metadata";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigService } from "@nestjs/config";
import WebSocket from "ws";
import { LkChatClient } from "../src/communications/lk-chat.client";

// Opt-in fixture from LK's legacy candidate harness on a disposable database.
// No root .env, shared servers, grants or external recipients.
const path = process.env.EDO_TEST_LK_HARNESS;
const fixture = path ? JSON.parse(readFileSync(path, "utf8")) as {
  url: string; chat_uuid: string; other_chat_uuid: string; actor_user_code_1c: string;
} : null;
if (fixture && !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.url))
  throw new Error("Refusing a non-disposable LK contract server");
const sockets = new Set<WebSocket>();
const client = () => new LkChatClient(new ConfigService({
  LK_CHAT_BASE_URL: fixture!.url, JWT_SECRET: "cross-contract-isolated-secret",
}));
async function waitFor(check: () => boolean) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Local contract event timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function connect(candidate: boolean) {
  const url = new URL("/ws/candidates/chat", fixture!.url);
  url.protocol = "ws:";
  url.searchParams.set("chat_uuid", fixture!.chat_uuid);
  url.searchParams.set("candidate_flag", String(candidate));
  const ws = new WebSocket(url); sockets.add(ws);
  const events: Record<string, unknown>[] = [];
  ws.on("message", bytes => events.push(JSON.parse(bytes.toString())));
  await once(ws, "open");
  await waitFor(() => events.some(event => event.action === "history_chat"));
  return { ws, events };
}
function send(ws: WebSocket, text: string) {
  ws.send(JSON.stringify({event:"send_message",data:{
    chat_uuid:fixture!.chat_uuid, user_code_1c:fixture!.actor_user_code_1c, message:text,
  }}));
}
function contains(events: Record<string, unknown>[], text: string) {
  return events.some(event => event.action === "new_entry" &&
    (event.entry as {message?:{content?:string}} | undefined)?.message?.content === text);
}
describe.skipIf(!fixture)("real LK legacy candidate protocol", () => {
  afterAll(() => {for (const ws of sockets) ws.terminate();});
  it("reads real history without an operator grant", async () => {
    const page = await client().history("synthetic",fixture!.chat_uuid,50,0);
    expect(Array.isArray(page.items)).toBe(true);
  });
  it("keeps two candidate and two operator windows connected after one closes", async () => {
    const windows = await Promise.all([connect(true),connect(true),connect(false),connect(false)]);
    const first = `multi-${randomUUID()}`;
    send(windows[2].ws,first);
    await waitFor(() => windows.every(window=>contains(window.events,first)));
    windows[0].ws.close(); await once(windows[0].ws,"close");
    const second = `survivor-${randomUUID()}`;
    send(windows[3].ws,second);
    await waitFor(() => windows.slice(1).every(window=>contains(window.events,second)));
  });
  it("sends through the existing event and receives a persisted message in history", async () => {
    const text = `edo-${randomUUID()}`;
    const id = await client().sendText(fixture!.chat_uuid,fixture!.actor_user_code_1c,text,randomUUID());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const page = await client().history("synthetic",fixture!.chat_uuid,100,0);
    expect(page.items).toContainEqual(expect.objectContaining({id:`lk:${id}`,text}));
  });
  it("uploads binary bytes through the unchanged file-message route", async () => {
    const text = `file-${randomUUID()}`;
    const id = await client().sendFile(fixture!.chat_uuid,fixture!.actor_user_code_1c,text,{
      filename:"synthetic.pdf",mimeType:"application/pdf",bytes:Buffer.from("%PDF-1.4\nsynthetic contract fixture\n%%EOF"),
    },randomUUID());
    const page = await client().history("synthetic",fixture!.chat_uuid,100,0);
    expect(page.items).toContainEqual(expect.objectContaining({id:`lk:${id}`,text,
      attachments:expect.arrayContaining([expect.objectContaining({filename:"synthetic.pdf"})]),
    }));
  });
});

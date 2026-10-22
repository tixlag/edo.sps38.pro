import "reflect-metadata";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigService } from "@nestjs/config";
import WebSocket, { WebSocketServer } from "ws";
import { LkChatClient } from "../src/communications/lk-chat.client";

// Started by LK's opt-in TestCandidateOperatorCrossRuntimeHarness on the one
// disposable MariaDB. No automatic discovery, root .env, or external providers.
const path = process.env.EDO_TEST_LK_HARNESS;
const fixture = path
  ? (JSON.parse(readFileSync(path, "utf8")) as {
      url: string;
      chat_uuid: string;
      other_chat_uuid: string;
      actor_user_code_1c: string;
    })
  : null;
if (fixture && !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.url))
  throw new Error("Refusing a non-disposable LK contract server");
const token = "candidate-test-service-token-not-production";
const sockets = new Set<WebSocket>();
const client = (url = fixture!.url) =>
  new LkChatClient(
    new ConfigService({
      LK_CHAT_BASE_URL: url,
      LK_CANDIDATE_OPERATOR_TOKEN: token,
      JWT_SECRET: "cross-contract-test-secret-not-production",
    }),
  );

async function grant(canSend = true) {
  const response = await fetch(`${fixture!.url}/candidates/operator-grants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_uuid: fixture!.chat_uuid,
      actor_user_code_1c: fixture!.actor_user_code_1c,
      can_send: canSend,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { grant: string }).grant;
}

async function connect(query: Record<string, string>) {
  const url = new URL("/ws/candidates/chat", fixture!.url);
  url.protocol = "ws:";
  url.searchParams.set("chat_uuid", fixture!.chat_uuid);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  const ws = new WebSocket(url);
  sockets.add(ws);
  const events: Record<string, unknown>[] = [];
  ws.on("message", (data) => events.push(JSON.parse(data.toString())));
  await once(ws, "open");
  await waitFor(() => events.some((event) => event.action === "history_chat"));
  return { ws, events };
}

async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= until) throw new Error("Local contract event timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function send(
  ws: WebSocket,
  operationId: string,
  extra: Record<string, unknown> = {},
) {
  ws.send(
    JSON.stringify({
      event: "send_message",
      data: {
        operation_id: operationId,
        chat_uuid: fixture!.chat_uuid,
        message: "Synthetic contract message",
        ...extra,
      },
    }),
  );
}

const pdf = {
  filename: "synthetic.pdf",
  mimeType: "application/pdf",
  bytes: Buffer.from("%PDF-1.4\n% synthetic contract fixture\n%%EOF\n"),
};

describe.skipIf(!fixture)(
  "EDO client against actual LK Go routes and MariaDB",
  () => {
    beforeAll(async () => {
      expect(fixture!.chat_uuid).not.toBe(fixture!.other_chat_uuid);
    });
    afterAll(() => {
      for (const ws of sockets) ws.terminate();
    });

    it("persists independent identical texts, replays one operation and refuses changed content", async () => {
      const lk = client(),
        firstOp = randomUUID(),
        secondOp = randomUUID();
      const [first, second] = await Promise.all([
        lk.sendText(
          fixture!.chat_uuid,
          fixture!.actor_user_code_1c,
          "Same synthetic text",
          firstOp,
        ),
        lk.sendText(
          fixture!.chat_uuid,
          fixture!.actor_user_code_1c,
          "Same synthetic text",
          secondOp,
        ),
      ]);
      expect(first).not.toBe(second);
      expect(
        await lk.sendText(
          fixture!.chat_uuid,
          fixture!.actor_user_code_1c,
          "Same synthetic text",
          firstOp,
        ),
      ).toBe(first);
      await expect(
        lk.sendText(
          fixture!.chat_uuid,
          fixture!.actor_user_code_1c,
          "Changed synthetic text",
          firstOp,
        ),
      ).rejects.toMatchObject({ code: "OPERATION_CONFLICT", uncertain: false });
      const history = await lk.history(
        "synthetic-candidate",
        fixture!.chat_uuid,
        100,
        0,
      );
      expect(
        history.items.filter((item) => item.id === `lk:${first}`),
      ).toHaveLength(1);
      expect(
        history.items.filter((item) => item.id === `lk:${second}`),
      ).toHaveLength(1);
    });

    it("persists a file receipt, replays it and refuses changed file content", async () => {
      const lk = client(),
        operation = randomUUID();
      const message = await lk.sendFile(
        fixture!.chat_uuid,
        fixture!.actor_user_code_1c,
        "Synthetic file",
        pdf,
        operation,
      );
      expect(
        await lk.sendFile(
          fixture!.chat_uuid,
          fixture!.actor_user_code_1c,
          "Synthetic file",
          pdf,
          operation,
        ),
      ).toBe(message);
      await expect(
        lk.sendFile(
          fixture!.chat_uuid,
          fixture!.actor_user_code_1c,
          "Synthetic file",
          { ...pdf, bytes: Buffer.concat([pdf.bytes, Buffer.from("changed")]) },
          operation,
        ),
      ).rejects.toMatchObject({ code: "OPERATION_CONFLICT", uncertain: false });
      const history = await lk.history(
        "synthetic-candidate",
        fixture!.chat_uuid,
        100,
        0,
      );
      expect(
        history.items.find((item) => item.id === `lk:${message}`)
          ?.attachments[0].filename,
      ).toBe(pdf.filename);
    });

    it("keeps two ERP style windows and a candidate connected when one operator closes", async () => {
      const one = await connect({ operator_grant: await grant() });
      const two = await connect({ operator_grant: await grant() });
      const candidate = await connect({ candidate_flag: "true" });
      const id = await client().sendText(
        fixture!.chat_uuid,
        fixture!.actor_user_code_1c,
        "Synthetic fanout one",
        randomUUID(),
      );
      const received = (events: Record<string, unknown>[], messageId: string) =>
        events.some(
          (event) =>
            event.action === "new_entry" &&
            (event.entry as { message?: { uuid: string } })?.message?.uuid ===
              messageId,
        );
      await waitFor(() =>
        [one, two, candidate].every((socket) => received(socket.events, id)),
      );
      one.ws.close();
      await once(one.ws, "close");
      const next = await client().sendText(
        fixture!.chat_uuid,
        fixture!.actor_user_code_1c,
        "Synthetic fanout two",
        randomUUID(),
      );
      await waitFor(() =>
        [two, candidate].every((socket) => received(socket.events, next)),
      );
      two.ws.close();
      candidate.ws.close();
    });

    it("rejects anonymous operator mode, changed author/chat and a read-only send", async () => {
      const response = await fetch(
        `${fixture!.url}/ws/candidates/chat?chat_uuid=${fixture!.chat_uuid}`,
      );
      expect(response.status).toBe(401);
      const operator = await connect({ operator_grant: await grant() });
      for (const patch of [
        { user_code_1c: "FORGED" },
        { chat_uuid: fixture!.other_chat_uuid },
      ]) {
        const operation = randomUUID();
        send(operator.ws, operation, patch);
        await waitFor(() =>
          operator.events.some((event) => event.operation_id === operation),
        );
        expect(
          operator.events.find((event) => event.operation_id === operation),
        ).toMatchObject({ status: "FAILED", message_uuid: null });
      }
      const readOnly = await connect({ operator_grant: await grant(false) });
      const operation = randomUUID();
      send(readOnly.ws, operation);
      await waitFor(() =>
        readOnly.events.some((event) => event.operation_id === operation),
      );
      expect(
        readOnly.events.find((event) => event.operation_id === operation),
      ).toMatchObject({ status: "FAILED", error_code: "SEND_FORBIDDEN" });
      const publicCandidate = await connect({
        candidate_flag: "true",
        user_code_1c: "FORGED",
        operator_1c: "true",
      });
      const before = await client().history(
        "synthetic-candidate",
        fixture!.chat_uuid,
        100,
        0,
      );
      send(publicCandidate.ws, randomUUID(), { user_code_1c: "FORGED" });
      // An ordered history request is processed after the rejected candidate send.
      publicCandidate.events.length = 0;
      publicCandidate.ws.send(
        JSON.stringify({
          event: "get_chat_history",
          data: { chat_uuid: fixture!.chat_uuid },
        }),
      );
      await waitFor(() =>
        publicCandidate.events.some((event) => event.action === "history_chat"),
      );
      const after = await client().history(
        "synthetic-candidate",
        fixture!.chat_uuid,
        100,
        0,
      );
      expect(after.items.map((item) => item.id)).toEqual(
        before.items.map((item) => item.id),
      );
      operator.ws.close();
      readOnly.ws.close();
      publicCandidate.ws.close();
    });

    it("rejects author/chat spoofing for files and the legacy operator upload route", async () => {
      const bearer = await grant();
      for (const patch of [
        { user_code_1c: "FORGED" },
        { chat_uuid: fixture!.other_chat_uuid },
      ]) {
        const form = new FormData();
        form.set("operation_id", randomUUID());
        form.set("chat_uuid", fixture!.chat_uuid);
        for (const [key, value] of Object.entries(patch)) form.set(key, value);
        form.set(
          "file",
          new Blob([pdf.bytes], { type: pdf.mimeType }),
          pdf.filename,
        );
        const response = await fetch(
          `${fixture!.url}/candidates/operator/files`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${bearer}` },
            body: form,
          },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          status: "FAILED",
          message_uuid: null,
        });
      }
      const legacy = await fetch(
        `${fixture!.url}/chats/upload/file-message?chat_uuid=${fixture!.chat_uuid}&operator_1c=true&user_id=${fixture!.actor_user_code_1c}`,
        { method: "POST" },
      );
      expect(legacy.status).toBe(403);
    });

    it.each(["text", "file"])(
      "keeps a committed %s UNKNOWN when its acknowledgement is lost, then replays once",
      async (kind) => {
        const operation = randomUUID();
        const upstreams = new Set<WebSocket>();
        const proxy = createServer(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const upstream = await fetch(new URL(request.url!, fixture!.url), {
            method: request.method,
            headers: {
              Authorization: request.headers.authorization!,
              "Content-Type": request.headers["content-type"]!,
            },
            body: Buffer.concat(chunks),
          });
          const body = await upstream.text();
          if (request.url === "/candidates/operator/files") {
            // The real Go handler has already committed and produced its receipt.
            expect(JSON.parse(body).status).toBe("SENT");
            response.destroy();
            return;
          }
          response.writeHead(upstream.status, {
            "Content-Type": "application/json",
          });
          response.end(body);
        });
        const wss = new WebSocketServer({ noServer: true });
        proxy.on("upgrade", (request, socket, head) => {
          wss.handleUpgrade(request, socket, head, (downstream) => {
            sockets.add(downstream);
            const url = new URL(request.url!, fixture!.url);
            url.protocol = "ws:";
            const upstream = new WebSocket(url, {
              headers: { Authorization: request.headers.authorization! },
            });
            upstreams.add(upstream);
            downstream.on("message", (message) => upstream.send(message));
            upstream.on("message", (message) => {
              if (JSON.parse(message.toString()).action === "send_ack")
                downstream.terminate();
              else if (downstream.readyState === WebSocket.OPEN)
                downstream.send(message);
            });
            upstream.on("error", () => downstream.terminate());
            downstream.on("close", () => upstream.terminate());
          });
        });
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        try {
          const address = proxy.address() as { port: number };
          const transmit = (lk: LkChatClient) =>
            kind === "text"
              ? lk.sendText(
                  fixture!.chat_uuid,
                  fixture!.actor_user_code_1c,
                  "Synthetic lost receipt",
                  operation,
                )
              : lk.sendFile(
                  fixture!.chat_uuid,
                  fixture!.actor_user_code_1c,
                  "Synthetic lost receipt",
                  pdf,
                  operation,
                );
          await expect(
            transmit(client(`http://127.0.0.1:${address.port}`)),
          ).rejects.toMatchObject({ uncertain: true });
          const message = await transmit(client());
          const history = await client().history(
            "synthetic-candidate",
            fixture!.chat_uuid,
            100,
            0,
          );
          expect(
            history.items.filter((item) => item.id === `lk:${message}`),
          ).toHaveLength(1);
        } finally {
          for (const ws of upstreams) ws.terminate();
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          proxy.close();
        }
      },
    );
  },
);

import { afterEach, describe, expect, it, vi } from "vitest";
import { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";

const pdf = Buffer.from("%PDF-1.7\nsynthetic");
function client() {
  const values: Record<string, string> = {
    ERP_COMMUNICATIONS_URL: "http://127.0.0.1:1/test",
    ERP_CANDIDATE_TOKEN: "test",
    ERP_USERNAME: "test",
    ERP_PASSWORD: "test",
  };
  return new ErpWorkspaceClient({ get: (key: string) => values[key] } as never);
}
afterEach(() => vi.unstubAllGlobals());
describe.each(["person", "candidate"] as const)(
  "ERP %s original proof",
  (recipient) => {
    const probe = (workspace: ErpWorkspaceClient) =>
      recipient === "person"
        ? workspace.probePersonOriginal("code", "person", "document")
        : workspace.probeCandidateOriginal("candidate", "document");
    it.each([
      "text/html; charset=utf-8",
      "application/json",
      "application/xml",
      "text/xml",
      null,
    ])("rejects technical or missing MIME %s", async (mime) => {
      const headers = mime ? { "content-type": mime } : {};
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("<html>proxy error</html>", { status: 200, headers }),
        ),
      );
      expect(await probe(client())).toBe(false);
    });
    it("accepts a complete PDF, including octet-stream only with file signature evidence", async () => {
      for (const mime of ["application/pdf", "application/octet-stream"]) {
        const fetch = vi.fn(
          async () =>
            new Response(pdf, {
              status: 200,
              headers: { "content-type": mime },
            }),
        );
        vi.stubGlobal("fetch", fetch);
        expect(await probe(client())).toBe(true);
        expect(fetch.mock.calls[0][1]).toMatchObject({
          signal: expect.any(AbortSignal),
          redirect: "error",
        });
        const requested = new URL(fetch.mock.calls[0][0]);
        expect(Object.fromEntries(requested.searchParams)).toEqual(
          recipient === "person"
            ? {
                action: "person-document-original-by-code",
                code1c: "code",
                personUid: "person",
                id: "document",
              }
            : {
                action: "person-document-original",
                candidate: "candidate",
                id: "document",
              },
        );
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("<html>proxy error</html>", {
              status: 200,
              headers: { "content-type": "application/octet-stream" },
            }),
        ),
      );
      expect(await probe(client())).toBe(false);
    });
    it.each([
      ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
      [
        "image/png",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ],
      ["image/webp", Buffer.from("RIFF1234WEBP")],
    ])(
      "accepts %s with signature spanning response chunks",
      async (mime, bytes) => {
        const stream = new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        });
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(stream, {
                headers: {
                  "content-type": mime,
                  "content-length": String(bytes.length),
                },
              }),
          ),
        );
        expect(await probe(client())).toBe(true);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(pdf, { headers: { "content-type": mime } }),
          ),
        );
        expect(await probe(client())).toBe(false);
      },
    );
    it("rejects mismatched content length and oversized streams", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(pdf, {
              status: 200,
              headers: {
                "content-type": "application/pdf",
                "content-length": "999",
              },
            }),
        ),
      );
      expect(await probe(client())).toBe(false);
      let sent = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (sent++ === 101) controller.close();
          else {
            const chunk = Buffer.alloc(1024 * 1024);
            if (sent === 1) pdf.copy(chunk);
            controller.enqueue(chunk);
          }
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              status: 200,
              headers: { "content-type": "application/pdf" },
            }),
        ),
      );
      expect(await probe(client())).toBe(false);
    });
  },
);

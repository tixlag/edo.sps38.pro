import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";

const config = new ConfigService({
  ERP_COMMUNICATIONS_URL: "http://localhost/erp",
  ERP_CANDIDATE_TOKEN: "test",
  ERP_USERNAME: "test",
  ERP_PASSWORD: "test",
});
afterEach(() => vi.unstubAllGlobals());
describe("ERP workspace conflicts", () => {
  it.each([
    "CANDIDATE_DUPLICATE_REQUIRES_REVIEW",
    "EXISTING_PERSON_REQUIRES_EXPLICIT_SELECTION",
    "OPERATION_RESULT_UNKNOWN",
    "IDEMPOTENCY_CONFLICT",
  ])("exposes the safe conflict code %s", async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code, description: "private details" },
          { status: 409 },
        ),
      ),
    );
    const client = new ErpWorkspaceClient(config);
    await expect(
      client.request("create", z.object({}), {}, { requestId: "test" }),
    ).rejects.toThrow(code);
  });
  it("keeps unknown or malformed upstream conflict bodies private", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "PRIVATE_NAME", description: "private details" },
          { status: 409 },
        ),
      ),
    );
    const client = new ErpWorkspaceClient(config);
    await expect(
      client.request("create", z.object({}), {}, {}),
    ).rejects.toThrow("ERP_RELATION_OR_OPERATION_CONFLICT");
  });
  it("keeps oversized conflict bodies private and returns a conflict", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "OPERATION_RESULT_UNKNOWN", description: "x".repeat(9000) }, { status: 409 })));
    const client = new ErpWorkspaceClient(config);
    await expect(client.request("create", z.object({}), {}, {})).rejects.toThrow("ERP_RELATION_OR_OPERATION_CONFLICT");
  });

  describe("HTTP 500 photo upload failure", () => {
    it("throws descriptive ServiceUnavailableException when 1C ERP returns PHOTO_UPLOAD_FAILED", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { code: "PHOTO_UPLOAD_FAILED", description: "Поле не найдено" },
            { status: 500 },
          ),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(
        client.uploadCandidatePhoto(
          {
            candidate: "uuid",
            actor: "test",
            requestId: "req-1",
            extension: "webp",
          },
          Buffer.from("fake-image"),
        ),
      ).rejects.toThrow("ERP_PHOTO_UPLOAD_FAILED: Поле не найдено");
    });
  });

  describe("HTTP 403 forbidden responses", () => {
    it("throws ForbiddenException for ACTOR_NOT_FOUND_OR_AMBIGUOUS", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ code: "ACTOR_NOT_FOUND_OR_AMBIGUOUS" }, { status: 403 }),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(
        client.request("create", z.object({}), {}, { actor: "test" }),
      ).rejects.toThrow("ERP_ACTOR_NOT_FOUND_OR_AMBIGUOUS");
    });

    it("throws ForbiddenException for STATUS_OWNED_BY_DISPATCH_OR_HR", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ code: "STATUS_OWNED_BY_DISPATCH_OR_HR" }, { status: 403 }),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(
        client.request("status", z.object({}), {}, { statusId: "Прием" }),
      ).rejects.toThrow("STATUS_OWNED_BY_DISPATCH_OR_HR");
    });

    it("masks unknown 403 responses as ERP_FORBIDDEN", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ code: "SECRET_REASON" }, { status: 403 }),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(
        client.request("create", z.object({}), {}, { actor: "test" }),
      ).rejects.toThrow("ERP_FORBIDDEN");
    });
  });

  describe("HTTP 400 bad requests", () => {
    it("throws BadRequestException with safe validation codes", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { code: "POSITION_NOT_FOUND_OR_AMBIGUOUS" },
            { status: 400 },
          ),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(
        client.request("create", z.object({}), {}, { actor: "test" }),
      ).rejects.toThrow("POSITION_NOT_FOUND_OR_AMBIGUOUS");
    });
    it("throws BadRequestException('INVALID_CURSOR') when error is INVALID_CURSOR", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ error: "INVALID_CURSOR" }, { status: 400 }),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(client.arrivalPage(10, "stale-cursor")).rejects.toThrow(
        "INVALID_CURSOR",
      );
    });

    it("throws BadRequestException('INVALID_CURSOR') when code is INVALID_CURSOR", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ code: "INVALID_CURSOR" }, { status: 400 }),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(client.arrivalPage(10, "stale-cursor")).rejects.toThrow(
        "INVALID_CURSOR",
      );
    });

    it("throws ERP_UNAVAILABLE when 400 has other or unparseable body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ error: "OTHER_ERROR" }, { status: 400 }),
        ),
      );
      const client = new ErpWorkspaceClient(config);
      await expect(client.arrivalPage(10, "stale-cursor")).rejects.toThrow(
        "ERP_UNAVAILABLE",
      );
    });
  });
});

describe("ERP workspace cancellation", () => {
  it("cancels a stalled response body after headers", async () => {
    const controller = new AbortController();
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{"items":')); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } })));
    const client = new ErpWorkspaceClient(config);
    const result = client.employmentHistory("worker", "person", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("job deadline"));
    await expect(result).rejects.toThrow("job deadline");
    expect(cancelled).toBe(true);
  }, 1000);

  it("cancels original verification while reading the body", async () => {
    const controller = new AbortController();
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode("%PDF-")); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/pdf" } })));
    const result = new ErpWorkspaceClient(config).probePersonOriginal("worker", "person", "doc", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("job deadline"));
    await expect(result).rejects.toThrow("job deadline");
    expect(cancelled).toBe(true);
  }, 1000);
});

describe("ERP body cleanup deadlines", () => {
  it("does not wait for a stalled stream cancellation after its deadline", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode("%PDF-")); },
      cancel() { return new Promise<void>(() => undefined); },
    }), { headers: { "content-type": "application/pdf" } })));
    const result = new ErpWorkspaceClient(config).personOriginal("worker", "person", "doc", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("job deadline"));
    await expect(result).rejects.toThrow("job deadline");
  }, 500);
});

describe("ERP error body cancellation", () => {
  it.each([400, 409])("keeps the job deadline when an HTTP %s error body stalls", async (status) => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode("{")); },
    }), { status })));
    const result = new ErpWorkspaceClient(config).employmentHistory("worker", "person", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("job deadline"));
    await expect(result).rejects.toThrow("job deadline");
  });
});

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
});

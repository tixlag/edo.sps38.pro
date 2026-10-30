import { ConfigService } from "@nestjs/config";
import type { ExecutionContext } from "@nestjs/common";
import { createHmac } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentUploadGrantGuard,
  DocumentUploadGrantService,
} from "../src/documents/document-upload-grant.service";

const secret = "test-service-token";
const context = {
  documentUid: "6ffb1fd5-8341-11eb-ba8b-00259002db81",
  chat_uuid: "00000000-0000-4000-8000-000000000001",
  position_code_1c: "000000491",
  citizenship: "ru",
  code_1c: "00123",
};
describe("document upload capabilities", () => {
  let grants: DocumentUploadGrantService;
  beforeEach(() => {
    vi.useFakeTimers();
    grants = new DocumentUploadGrantService(
      new ConfigService({
        EDO_LK_INTERNAL_TOKEN: secret,
        EDO_PUBLIC_API_URL: "https://edo.example/api",
      }),
    );
  });
  afterEach(() => vi.useRealTimers());
  it("binds the owner context, document and bundle key and expires after five minutes", () => {
    const grant = grants.grant({ ...context, idempotencyKey: "bundle-key" });
    expect(grant.url).toBe("https://edo.example/api/candidate-documents");
    expect(grants.verify(grant.token)).toEqual({
      context,
      idempotencyKey: "bundle-key",
    });
    vi.advanceTimersByTime(300000);
    expect(() => grants.verify(grant.token)).toThrow("Invalid or expired");
  });
  it("accepts the additional bounded candidate profile fields in a signed grant", () => {
    const candidateSnapshot = {
      name: "И".repeat(512),
      photoPath: "p".repeat(2048),
      master: { name: "М".repeat(512), code: "M" },
      supervisor: { name: "С".repeat(512), code: "S" },
      mentor: { name: "Н".repeat(512) },
      sex: "female" as const,
      sexKnown: true,
    };
    const grant = grants.grant({
      ...context,
      candidateSnapshot,
      idempotencyKey: "bundle-key",
    });
    expect(grant.token.length).toBeGreaterThan(8192);
    expect(grants.verify(grant.token).context.candidateSnapshot).toMatchObject({
      photoPath: candidateSnapshot.photoPath,
      masterName: candidateSnapshot.master.name,
      supervisorName: candidateSnapshot.supervisor.name,
    });
  });
  it("rejects altered context, unified JWTs and opaque SSE credentials", () => {
    const grant = grants.grant({ ...context, idempotencyKey: "bundle-key" });
    const parts = grant.token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.context.chat_uuid = "00000000-0000-4000-8000-000000000002";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => grants.verify(parts.join("."))).toThrow();
    expect(() =>
      grants.verify(
        jwt.sign({ context }, secret, { issuer: "lk-auth-service" }),
      ),
    ).toThrow();
    expect(() => grants.verify("f".repeat(64))).toThrow();
    expect(() => grants.verify("f".repeat(64 * 1024 + 1))).toThrow();
  });
  it.each(["algorithm", "issuer", "audience", "expiry"])(
    "rejects invalid %s even with the signing key",
    (invalid) => {
      const key = createHmac("sha256", secret)
        .update("edo-document-upload-grants:v1")
        .digest("hex");
      const token = jwt.sign({ context, idempotencyKey: "bundle-key" }, key, {
        algorithm: invalid === "algorithm" ? "HS384" : "HS256",
        issuer:
          invalid === "issuer" ? "lk-auth-service" : "edo-document-upload",
        audience:
          invalid === "audience"
            ? "document-statuses"
            : "edo:candidate-document-upload",
        ...(invalid === "expiry" ? {} : { expiresIn: 300 }),
      });
      expect(() => grants.verify(token)).toThrow();
    },
  );
  it("requires the bundle key from the grant before accepting the body", () => {
    const grant = grants.grant({ ...context, idempotencyKey: "bundle-key" });
    const request = {
      headers: {
        authorization: `Bearer ${grant.token}`,
        "idempotency-key": "another-key",
      },
    };
    const execution = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    const guard = new DocumentUploadGrantGuard(grants);
    expect(() => guard.canActivate(execution)).toThrow(
      "Upload key does not match",
    );
    request.headers["idempotency-key"] = "bundle-key";
    expect(guard.canActivate(execution)).toBe(true);
  });
  it("fails closed without a server credential or owner", () => {
    const empty = new DocumentUploadGrantService(new ConfigService());
    expect(() => empty.grant({ ...context, idempotencyKey: "key" })).toThrow(
      "not configured",
    );
    expect(() =>
      grants.grant({
        ...context,
        chat_uuid: undefined,
        code_1c: undefined,
        idempotencyKey: "key",
      }),
    ).toThrow("Invalid document upload context");
  });
});

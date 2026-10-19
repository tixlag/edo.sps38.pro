import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LkCandidateIdentityService } from "../src/documents/lk-candidate-identity.service";
import {
  ErpCandidateClient,
  normalizeErpCandidate,
} from "../src/documents/erp-candidate.client";
import { withinDocumentDeadline } from "../src/documents/candidate-document.error";

const uuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
const config = new ConfigService({
  LK_BASE_URL: "https://lk.example",
  LK_EDO_INTERNAL_TOKEN: "service",
  ERP_CANDIDATE_URL: "https://erp.example/Candidate",
  ERP_CANDIDATE_TOKEN: "secret",
  ERP_USERNAME: "user",
  ERP_PASSWORD: "password",
});
const card = { uuid, citizenship: "ru", position: { code: "000491" } };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("candidate identity and source error diagnostics", () => {
  it.each([
    [401, "DOCUMENTS_INTEGRATION_MISCONFIGURED", 503, false],
    [403, "DOCUMENTS_INTEGRATION_MISCONFIGURED", 503, false],
    [400, "LK_CONTRACT_ERROR", 502, false],
    [503, "LK_UNAVAILABLE", 503, true],
  ])(
    "classifies LK HTTP %s without exposing upstream bodies",
    async (status, code, httpStatus, retryable) => {
      const fetcher = vi.fn(
        async () =>
          new Response("private upstream payload", {
            status: status as number,
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const error = await new LkCandidateIdentityService(config)
        .byEmployee("УП000123")
        .catch((e) => e);
      expect(error.getStatus()).toBe(httpStatus);
      expect(error.getResponse()).toMatchObject({ code, retryable });
      expect(JSON.stringify(error.getResponse())).not.toContain("private");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("distinguishes a missing own association from an invalid guest link", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const service = new LkCandidateIdentityService(config);
    await expect(service.byEmployee("УП000123")).rejects.toMatchObject({
      code: "CANDIDATE_LINK_MISSING",
    });
    await expect(service.byUuid(uuid)).rejects.toMatchObject({
      code: "CANDIDATE_CHAT_NOT_FOUND",
    });
  });
  it("rejects invalid employee identities before contacting LK", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new LkCandidateIdentityService(config).byEmployee("../other"),
    ).rejects.toMatchObject({ code: "EMPLOYEE_IDENTITY_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("classifies malformed JSON as a permanent contract error", async () => {
    vi.stubGlobal("fetch", async () => new Response("not JSON"));
    await expect(
      new LkCandidateIdentityService(config).byEmployee("УП000123"),
    ).rejects.toMatchObject({ code: "LK_CONTRACT_ERROR" });
  });
  it("classifies a LK deadline separately from an unavailable server", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async (_url: string, init: Parameters<typeof fetch>[1]) => {
        return new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          ),
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const result = expect(
      new LkCandidateIdentityService(config).byEmployee("УП000123"),
    ).rejects.toMatchObject({ code: "LK_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5100);
    await result;
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([undefined, null, "", " \t\n"])(
    "defaults missing ERP citizenship to ru (%s)",
    (citizenship) => {
      expect(
        normalizeErpCandidate({ ...card, citizenship }, uuid),
      ).toMatchObject({
        citizenship: "ru",
        position: card.position,
      });
    },
  );
  it("preserves explicitly provided foreign citizenship", () => {
    expect(
      normalizeErpCandidate({ ...card, citizenship: "UZ" }, uuid),
    ).toMatchObject({ citizenship: "uz" });
  });
  it.each(["Russia", " UZ ", 0, false, {}])(
    "rejects malformed citizenship instead of defaulting it (%s)",
    (citizenship) => {
      expect(() =>
        normalizeErpCandidate({ ...card, citizenship }, uuid),
      ).toThrowError(expect.objectContaining({ code: "ERP_CONTRACT_ERROR" }));
    },
  );
  it("still identifies the missing position when citizenship is absent", () => {
    expect(() => normalizeErpCandidate({ uuid }, uuid)).toThrowError(
      expect.objectContaining({
        code: "CANDIDATE_PROFILE_INCOMPLETE",
        fields: ["positionCode"],
      }),
    );
  });
  it.each([
    [6000, true],
    [16_000, false],
  ])("bounds a slow ERP response after %s ms", async (delay, succeeds) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("timeout")), ms);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      (_url: string, init: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(Response.json(card)),
            delay as number,
          );
          init!.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init!.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    const request = new ErpCandidateClient(config).findByChatUuid(uuid);
    const result = succeeds
      ? expect(request).resolves.toMatchObject(card)
      : expect(request).rejects.toMatchObject({
          code: "ERP_TIMEOUT",
          transient: true,
        });
    await vi.advanceTimersByTimeAsync(delay as number);
    await result;
  });
  it("bounds the caller without cancelling shared work or leaking an unhandled rejection", async () => {
    const controller = new AbortController();
    let complete!: (value: string) => void;
    const shared = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const caller = withinDocumentDeadline(shared, controller.signal);
    controller.abort();
    await expect(caller).rejects.toMatchObject({ code: "DOCUMENTS_TIMEOUT" });
    complete("another caller may use this");
    await expect(shared).resolves.toBe("another caller may use this");
  });
});

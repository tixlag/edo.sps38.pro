import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CandidateWorkspaceDto } from "@edo/api-client";
import { useCandidateRequest } from "./use-candidate-request";
const api = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@edo/api-client", () => ({
  useGetCandidateOperation: () => ({ refetch: api.lookup }),
  getGetCandidateOperationQueryKey: (id: string) => ["operation", id],
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let request: ReturnType<typeof useCandidateRequest>;
const profile = { id: "existing" } as CandidateWorkspaceDto;
beforeEach(() => {
  vi.clearAllMocks();
  root = createRoot(document.createElement("div"));
  function Harness() {
    request = useCandidateRequest();
    return null;
  }
  act(() => root.render(<Harness />));
});
afterEach(() => act(() => root.unmount()));
describe("candidate operation recovery", () => {
  it.each([
    [
      "INVALID_PERSON_MATCH_NAME",
      "обновление интеграции с карточками кандидатов",
    ],
    ["REQUIRED_FIELD_MISSING", "обновление интеграции с карточками кандидатов"],
    ["SOURCE_COMMENT_REQUIRED", "комментарий"],
    ["SOURCE_REFERRER_REQUIRED", "физлицо"],
    ["INTERNSHIP_END_DATE_REQUIRED", "окончания практики"],
  ])(
    "allows correcting %s with a readable message and a new operation ID",
    async (code, text) => {
      const original = request.requestId;
      await act(async () =>
        request.execute(
          vi.fn().mockRejectedValue({
            response: { status: 400, data: { message: code } },
          }),
          vi.fn(),
        ),
      );
      expect(request.locked).toBe(false);
      expect(request.requestId).not.toBe(original);
      expect(request.error).toContain(text);
      expect(request.error).not.toContain(code);
    },
  );
  it("unlocks known business 409 with a new request ID", async () => {
    const original = request.requestId;
    await act(async () =>
      request.execute(
        vi.fn().mockRejectedValue({
          response: {
            status: 409,
            data: { message: "ERP_CANDIDATE_DUPLICATE_REQUIRES_REVIEW" },
          },
        }),
        vi.fn(),
      ),
    );
    expect(request.locked).toBe(false);
    expect(request.requestId).not.toBe(original);
    expect(request.error).toContain("Откройте подходящую карточку");
    expect(request.error).not.toContain("CANDIDATE_DUPLICATE");
  });
  it("queries unknown results before retrying the exact captured body and signed choice", async () => {
    const id = request.requestId;
    const body = {
      requestId: id,
      personSelection: "original-signed-choice",
      fields: { phone: "111" },
    };
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValue(profile);
    const confirmed = vi.fn();
    await act(async () => request.execute(() => send(body), confirmed));
    expect(request.locked).toBe(true);
    expect(request.requestId).toBe(id);
    api.lookup.mockResolvedValue({ data: { state: "UNKNOWN" } });
    await act(async () =>
      request.execute(() => send({ fields: { phone: "changed" } }), confirmed),
    );
    expect(send).toHaveBeenCalledTimes(1);
    api.lookup.mockResolvedValue({ data: { state: "NOT_FOUND" } });
    await act(async () =>
      request.execute(() => send({ fields: { phone: "changed" } }), confirmed),
    );
    expect(send).toHaveBeenNthCalledWith(2, body);
    expect(confirmed).toHaveBeenCalledWith(profile);
  });
  it("uses the recovered success and unlocks a stored rejection", async () => {
    const confirmed = vi.fn();
    await act(async () =>
      request.execute(vi.fn().mockRejectedValue(new Error("lost")), confirmed),
    );
    api.lookup.mockResolvedValue({
      data: { state: "SUCCEEDED", candidate: profile },
    });
    const retry = vi.fn();
    await act(async () => request.execute(retry, confirmed));
    expect(confirmed).toHaveBeenCalledWith(profile);
    expect(retry).not.toHaveBeenCalled();
    api.lookup.mockResolvedValue({
      data: { state: "REJECTED", code: "ERP_CURRENT_CANDIDATE_AMBIGUOUS" },
    });
    const id = request.requestId;
    await act(async () => request.execute(retry, confirmed));
    expect(request.locked).toBe(false);
    expect(request.requestId).not.toBe(id);
    expect(request.error).toContain("Откройте нужную карточку");
    expect(request.error).not.toContain("CURRENT_CANDIDATE_AMBIGUOUS");
  });
  it("blocks an idempotency conflict returned by operation lookup", async () => {
    const id = request.requestId;
    const send = vi.fn().mockRejectedValue(new Error("lost"));
    await act(async () => request.execute(send, vi.fn()));
    api.lookup.mockResolvedValue({
      data: { state: "UNKNOWN", code: "IDEMPOTENCY_CONFLICT" },
    });
    await act(async () => request.execute(send, vi.fn()));
    expect(request.blocked).toBe(true);
    expect(request.requestId).toBe(id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(request.error).toContain("Повторное сохранение остановлено");
  });
  it("keeps idempotency conflict distinct and never resubmits or rotates its ID", async () => {
    const id = request.requestId;
    const send = vi.fn().mockRejectedValue({
      response: {
        status: 409,
        data: { message: "ERP_IDEMPOTENCY_CONFLICT" },
      },
    });
    await act(async () => request.execute(send, vi.fn()));
    await act(async () => request.execute(send, vi.fn()));
    expect(request.locked).toBe(true);
    expect(request.requestId).toBe(id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(api.lookup).not.toHaveBeenCalled();
    expect(request.error).toContain("Обратитесь к администратору");
  });
});

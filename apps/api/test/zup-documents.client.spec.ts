import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { HttpException } from "@nestjs/common";
import { ZupDocumentsClient } from "../src/contracts/zup-documents.client";

function client(extra: Record<string, string> = {}) {
  return new ZupDocumentsClient(
    new ConfigService({
      ZUP_DOCUMENTS_BASIC_AUTH: "dGVzdDp0ZXN0",
      ZUP_DOCUMENTS_API_KEY: "test-key",
      ...extra,
    }),
  );
}
const types = [
  {
    code: "employment_contract_general",
    name: "Трудовой договор",
    source_object: "Справочник.Сотрудники",
  },
];
const input = {
  full_name: "Тестов Тест Тестович",
  birth_date: "15.04.1968",
  document_type: types[0].code,
};
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function expectHttp(
  promise: Promise<unknown>,
  status: number,
  text: string,
) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(status);
  expect((error as HttpException).message).toContain(text);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("ZupDocumentsClient", () => {
  it("fetches dynamic types with both server credentials and bounded nonredirecting request", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response({ document_types: types }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().types()).toEqual(types);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      "http://10.10.2.0/ZUP3_SPS_labs/hs/zup-documents/document-types",
    );
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Basic dGVzdDp0ZXN0", "X-API-Key": "test-key" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("sends exact employment-contract payload and preserves returned PDF bytes", async () => {
    const bytes = Buffer.from("%PDF-1.7\noriginal");
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(bytes, { headers: { "Content-Type": "application/pdf" } }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await client().generate(input)).toEqual(bytes);
    expect(String(fetch.mock.calls[0][0])).toContain("/employment-contract");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
    expect(fetch.mock.calls[0][1].method).toBe("POST");
  });
  it("fails closed before network when credentials are missing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expectHttp(
      client({ ZUP_DOCUMENTS_API_KEY: "" }).types(),
      503,
      "не настроено",
    );
    await expectHttp(
      client({ ZUP_DOCUMENTS_BASIC_AUTH: "Basic dGVzdDp0ZXN0" }).types(),
      503,
      "не настроено",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [400, "invalid_request", 400, "Проверьте"],
    [404, "employee_not_found", 404, "не найден"],
    [409, "employee_ambiguous", 409, "несколько"],
    [500, "generation_failed", 502, "сформировать"],
    [401, "unauthorized", 503, "авторизацию"],
    [403, "unauthorized", 503, "авторизацию"],
  ])(
    "maps ZUP %s/%s to safe status %s",
    async (status, code, expected, text) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            response(
              { error: code, message: "private upstream detail" },
              status,
            ),
          ),
      );
      await expectHttp(client().generate(input), expected, text);
    },
  );
  it.each([
    { document_types: [{ code: "only-code" }] },
    { document_types: [types[0], types[0]] },
    {},
  ])("rejects invalid/duplicate catalog entries", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
    await expectHttp(client().types(), 502, "некорректный ответ");
  });
  it("rejects incorrect successful content type and missing PDF magic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ error: "error" })),
    );
    await expectHttp(client().generate(input), 502, "некорректный ответ");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("not pdf", {
            headers: { "Content-Type": "application/pdf" },
          }),
        ),
    );
    await expectHttp(client().generate(input), 502, "некорректный ответ");
  });
  it("bounds declared and actual JSON response sizes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("{}", {
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "2000000",
            },
          }),
        ),
    );
    await expectHttp(client().types(), 502, "некорректный ответ");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(" ".repeat(1024 * 1024 + 1), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    await expectHttp(client().types(), 502, "некорректный ответ");
  });
  it("bounds PDF content length without reading its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("%PDF-1.7", {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Length": String(50 * 1024 * 1024 + 1),
            },
          }),
        ),
    );
    await expectHttp(client().generate(input), 502, "некорректный ответ");
  });
  it("maps network failures without leaking error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private upstream secret")),
    );
    await expectHttp(client().types(), 502, "Не удалось связаться");
  });
  it("maps an aborted upstream deadline to 504", async () => {
    const originalTimeout = AbortSignal.timeout;
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    );
    await expectHttp(client().types(), 504, "не ответила вовремя");
    timeout.mockRestore();
    expect(AbortSignal.timeout).toBe(originalTimeout);
  });
});

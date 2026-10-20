import { afterEach, describe, expect, it, vi } from "vitest";
import { captureErpDeliveryResponse } from "../src/documents/erp-delivery-response";

afterEach(() => vi.useRealTimers());

describe("ERP delivery response capture", () => {
  it.each(["application/pdf", "image/png", "application/octet-stream"])(
    "does not store binary response contents (%s)",
    async (contentType) => {
      const result = await captureErpDeliveryResponse(
        new Response("private binary file", {
          headers: { "content-type": contentType },
        }),
        [],
      );
      expect(result.responseBody).toBe("[binary response omitted]");
      expect(result.httpStatus).toBe(200);
    },
  );
  it("does not store a PDF echoed with a text content type", async () => {
    const result = await captureErpDeliveryResponse(
      new Response("%PDF-1.7 private file"),
      [],
    );
    expect(result.responseBody).toBe("[binary response omitted]");
  });
  it("retains the actual ERP validation reason and HTTP status", async () => {
    const body = {
      success: false,
      code: 400,
      description: "Должность по positionUid не найдена.",
    };
    expect(
      await captureErpDeliveryResponse(
        Response.json(body, { status: 400 }),
        [],
      ),
    ).toEqual({
      httpStatus: 400,
      responseBody: JSON.stringify(body),
      responseTruncated: false,
      responseReadError: null,
    });
  });
  it("records an empty successful response", async () => {
    expect(
      await captureErpDeliveryResponse(new Response(null, { status: 204 }), []),
    ).toEqual({
      httpStatus: 204,
      responseBody: "",
      responseTruncated: false,
      responseReadError: null,
    });
  });
  it("redacts nested credentials, echoed files, and secrets embedded in messages", async () => {
    const secret = 'private-"credential';
    const body = {
      description: `Rejected ${secret}`,
      nested: {
        Authorization: "Basic abc",
        refresh_token: "hidden",
        password: "hidden",
        fileBase64: "a".repeat(1000),
        other: "Bearer unknown-credential",
      },
    };
    const result = await captureErpDeliveryResponse(Response.json(body), [
      secret,
    ]);
    expect(JSON.parse(result.responseBody)).toEqual({
      description: "Rejected [redacted]",
      nested: {
        Authorization: "[redacted]",
        refresh_token: "[redacted]",
        password: "[redacted]",
        fileBase64: "[redacted]",
        other: "[redacted]",
      },
    });
    expect(result.responseBody).not.toContain(secret);
  });
  it("keeps plain text errors while removing echoed credentials", async () => {
    const result = await captureErpDeliveryResponse(
      new Response(
        "Invalid positionUid\nAuthorization: Basic abc\ntoken=private-value\nprivate-password",
        { status: 400 },
      ),
      ["private-password"],
    );
    expect(result.responseBody).toContain("Invalid positionUid");
    for (const value of ["Basic abc", "private-value", "private-password"])
      expect(result.responseBody).not.toContain(value);
  });
  it("bounds and cancels oversized responses, including truncated JSON file echoes", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"fileBase64":"' + "a".repeat(100_000)),
        );
      },
      cancel,
    });
    const result = await captureErpDeliveryResponse(
      new Response(stream, { status: 400 }),
      [],
    );
    expect(result.responseTruncated).toBe(true);
    expect(result.responseBody.length).toBeLessThanOrEqual(16 * 1024);
    expect(result.responseBody).not.toContain("a".repeat(100));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not mark an exact size response as truncated", async () => {
    const body = "x ".repeat(8192);
    const result = await captureErpDeliveryResponse(new Response(body), []);
    expect(result.responseBody).toBe(body);
    expect(result.responseTruncated).toBe(false);
  });
  it("preserves UTF-8 messages split across response chunks", async () => {
    const body = "Должность по positionUid не найдена.";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of Buffer.from(body))
          controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(
      (
        await captureErpDeliveryResponse(
          new Response(stream, { status: 400 }),
          [],
        )
      ).responseBody,
    ).toBe(body);
  });
  it("retains the HTTP status when reading the response stream fails", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("private upstream detail"));
      },
    });
    const result = await captureErpDeliveryResponse(
      new Response(stream, { status: 400 }),
      [],
    );
    expect(result).toMatchObject({
      httpStatus: 400,
      responseBody: "",
      responseReadError: "ERP_RESPONSE_READ_FAILED",
    });
  });
  it("bounds response reading even when the server never finishes its body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream({ start() {}, cancel });
    const pending = captureErpDeliveryResponse(
      new Response(stream, { status: 200 }),
      [],
    );
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toMatchObject({
      httpStatus: 200,
      responseReadError: "ERP_RESPONSE_READ_TIMEOUT",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

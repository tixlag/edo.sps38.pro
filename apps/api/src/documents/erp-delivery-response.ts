const MAX_RESPONSE_BYTES = 16 * 1024;
const READ_TIMEOUT_MS = 5000;
const sensitiveKey =
  /authorization|cookie|password|secret|token|(?:access|api).?key|file.?base64/i;

export interface ErpDeliveryResponse {
  httpStatus: number;
  responseBody: string;
  responseTruncated: boolean;
  responseReadError: string | null;
}

function sanitize(text: string, secrets: readonly string[]): string {
  const redactions = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  const redact = (value: string) => {
    for (const secret of redactions)
      value = value.split(secret).join("[redacted]");
    return value
      .replace(/\b(?:Bearer|Basic)\s+[^\s"<>]+/gi, "[redacted]")
      .replace(
        /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*/gi,
        "[redacted]",
      )
      .replace(
        /((?:"?(?:[\w-]*(?:token|password|secret|(?:access|api).?key)|file.?base64)"?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|[^\s,;<>]+)/gi,
        '$1"[redacted]"',
      )
      .replace(/[A-Za-z0-9+/_-]{128,}={0,2}/g, "[binary omitted]")
      .replace(/\p{Cc}/gu, (char) =>
        ["\n", "\r", "\t"].includes(char) ? char : "",
      );
  };
  try {
    return JSON.stringify(
      JSON.parse(text, (key, value: unknown) =>
        sensitiveKey.test(key)
          ? "[redacted]"
          : typeof value === "string"
            ? redact(value)
            : value,
      ),
    );
  } catch {
    return redact(text);
  }
}

/** Integration response only: never capture request headers, document fields, or PDF bytes. */
export async function captureErpDeliveryResponse(
  response: Response,
  secrets: readonly string[],
  inspect?: (raw: string) => void,
): Promise<ErpDeliveryResponse> {
  const result: ErpDeliveryResponse = {
    httpStatus: response.status,
    responseBody: "",
    responseTruncated: false,
    responseReadError: null,
  };
  if (!response.body) return result;
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    contentType &&
    !contentType.startsWith("text/") &&
    !/(?:json|xml)$/.test(contentType)
  ) {
    result.responseBody = "[binary response omitted]";
    void response.body.cancel().catch(() => undefined);
    return result;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let complete = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.body.getReader();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("ERP_RESPONSE_READ_TIMEOUT")),
        READ_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    while (!complete) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        complete = true;
        break;
      }
      const remaining = MAX_RESPONSE_BYTES - bytes;
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) {
        result.responseTruncated = true;
        break;
      }
    }
  } catch (error) {
    result.responseReadError =
      error instanceof Error && error.message === "ERP_RESPONSE_READ_TIMEOUT"
        ? "ERP_RESPONSE_READ_TIMEOUT"
        : "ERP_RESPONSE_READ_FAILED";
  } finally {
    clearTimeout(timer);
    if (reader) {
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const bytesRead = Buffer.concat(chunks);
  if (
    bytesRead
      .subarray(0, 16)
      .toString("ascii")
      .trimStart()
      .startsWith("%PDF-") ||
    bytesRead.includes(0) ||
    (bytesRead[0] === 0xff && bytesRead[1] === 0xd8)
  ) {
    result.responseBody = "[binary response omitted]";
    return result;
  }
  inspect?.(bytesRead.toString("utf8"));
  const body = sanitize(bytesRead.toString("utf8"), secrets);
  result.responseBody = body.slice(0, MAX_RESPONSE_BYTES);
  result.responseTruncated ||= body.length > MAX_RESPONSE_BYTES;
  return result;
}

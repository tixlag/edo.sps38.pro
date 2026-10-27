/** Bound untrusted storage/vendor responses before buffering them. */
export async function readOcrBody(
  response: Response,
  max: number,
): Promise<Buffer> {
  if (!response.body) throw new Error("OCR_CONTRACT_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > max) throw new Error("OCR_CONTRACT_INVALID");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

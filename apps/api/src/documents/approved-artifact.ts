import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

export const MAX_APPROVED_BYTES = 100 * 1024 * 1024;
export type DocumentTransport = "base64-v1" | "multipart-v2";
export const artifactExtensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
export interface ApprovedArtifact {
  key: string;
  mimeType: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
  preparation: string;
  transport: DocumentTransport;
}
export function assertArtifact(
  artifact: Pick<
    ApprovedArtifact,
    "mimeType" | "extension" | "filename" | "sizeBytes" | "sha256"
  >,
): void {
  if (
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 1 ||
    artifact.sizeBytes > MAX_APPROVED_BYTES ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
    artifactExtensions[artifact.mimeType] !== artifact.extension ||
    artifact.filename !== `document.${artifact.extension}`
  )
    throw new Error("APPROVED_ARTIFACT_INVALID");
}
/** Bounded working memory; ETag is deliberately never used as a checksum. */
export async function hashArtifact(
  body: Readable,
  maxBytes = MAX_APPROVED_BYTES,
): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) throw new Error("APPROVED_ARTIFACT_TOO_LARGE");
      hash.update(chunk);
    }
    if (!sizeBytes) throw new Error("APPROVED_ARTIFACT_EMPTY");
    return { sizeBytes, sha256: hash.digest("hex") };
  } finally {
    body.destroy();
  }
}

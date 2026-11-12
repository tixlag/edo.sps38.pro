import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  DocumentUploadService,
  type StagedUpload,
} from "../src/documents/document-upload.service";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const { writeFile } = await import("node:fs/promises");

const cache = join(__dirname, "../../../.cache/document-uploads/tests");
const parser = new DocumentUploadService();
const directories: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function request(bytes: Buffer, filename: string) {
  return {
    isMultipart: () => true,
    parts: async function* () {
      yield { type: "field", fieldname: "documentTypeCode", value: "PASSPORT" };
      yield {
        type: "file",
        fieldname: "files[]",
        filename,
        mimetype: "application/octet-stream",
        file: Readable.from([bytes]),
      };
    },
  } as never;
}

async function parse(bytes: Buffer, filename: string): Promise<StagedUpload> {
  const result = await parser.parse(request(bytes, filename));
  directories.push(result.directory);
  return result;
}

async function jpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 9, g: 8, b: 7 } },
  })
    .jpeg()
    .toBuffer();
}

/** The trailer a Huawei camera appends after the EOI marker. */
function withTrailer(bytes: Buffer): Buffer {
  return Buffer.concat([bytes, Buffer.alloc(1208)]);
}

afterEach(async () => {
  vi.mocked(writeFile).mockClear();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("JPEG trailer normalization on upload", () => {
  it("stores the canonical JPEG and keeps the original provenance", async () => {
    await mkdir(cache, { recursive: true });
    const bytes = await jpeg();
    const original = withTrailer(bytes);
    const upload = await parse(original, "IMG_20261112_104141.jpg");
    const file = upload.files[0];
    const canonical = await readFile(file.path);
    expect(canonical.equals(bytes)).toBe(true);
    expect(file).toMatchObject({
      filename: "IMG_20261112_104141.jpg",
      mimeType: "image/jpeg",
      sizeBytes: bytes.length,
      sha256: sha(bytes),
      pageCount: 1,
      source: {
        filename: "IMG_20261112_104141.jpg",
        mimeType: "image/jpeg",
        sizeBytes: original.length,
        sha256: sha(original),
      },
      normalization: "jpeg-trailer-trim-v1",
    });
    expect((await sharp(canonical).metadata()).format).toBe("jpeg");
  });

  it("keeps a clean JPEG byte identical and marks no normalization", async () => {
    await mkdir(cache, { recursive: true });
    const bytes = await jpeg();
    const upload = await parse(bytes, "photo.jpg");
    const file = upload.files[0];
    expect((await readFile(file.path)).equals(bytes)).toBe(true);
    expect(file.normalization).toBeUndefined();
    expect(file.source).toBeUndefined();
    expect(file.sha256).toBe(sha(bytes));
  });

  it("does not touch a PNG upload", async () => {
    await mkdir(cache, { recursive: true });
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const upload = await parse(bytes, "scan.png");
    expect(upload.files[0].mimeType).toBe("image/png");
    expect(upload.files[0].normalization).toBeUndefined();
  });

  it("fails the upload when the canonical file cannot be stored", async () => {
    await mkdir(cache, { recursive: true });
    const bytes = await jpeg();
    const original = withTrailer(bytes);
    vi.mocked(writeFile).mockRejectedValueOnce(
      new Error("ENOSPC: no space left on device"),
    );
    await expect(parse(original, "IMG_20261112_104141.jpg")).rejects.toThrow(
      "ENOSPC",
    );
    // The canonical file was the one that failed; the upload must not
    // continue with a path that points to a missing file.
    expect(vi.mocked(writeFile).mock.calls[0][0]).toContain(".trim");
  });

  it("keeps the original when the trimmed bytes do not decode", async () => {
    await mkdir(cache, { recursive: true });
    const bytes = await jpeg();
    const original = withTrailer(bytes);
    const real = parser.inspect.bind(parser);
    let calls = 0;
    const inspect = vi.spyOn(parser, "inspect").mockImplementation(async (b) => {
      calls += 1;
      // The trimmed bytes are rejected, the original is fine.
      if (calls === 1) throw new Error("damaged");
      return real(b);
    });
    try {
      const upload = await parse(original, "photo.jpg");
      const file = upload.files[0];
      expect(file.normalization).toBeUndefined();
      expect(file.source).toBeUndefined();
      expect((await readFile(file.path)).equals(original)).toBe(true);
      expect(calls).toBe(2);
    } finally {
      inspect.mockRestore();
    }
  });
});

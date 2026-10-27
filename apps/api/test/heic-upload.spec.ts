import "reflect-metadata";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import {
  DocumentUploadService,
  type StagedUpload,
} from "../src/documents/document-upload.service";
import { isHeic, normalizeHeic } from "../src/documents/heic-normalization";

const { quality, hasPrimaryTransform, exifOrientation } =
  require("../src/documents/heic-normalization.worker.cjs") as {
    quality(
      a: Buffer,
      b: Buffer,
      w: number,
      h: number,
    ): { acceptable: boolean; ssim: number; edgeMse: number };
    hasPrimaryTransform(b: Buffer): boolean;
    exifOrientation(b?: Buffer): number;
  };
const fixtures = join(__dirname, "fixtures/heic");
const cache = join(__dirname, "../../../.cache/heic/tests");
const parser = new DocumentUploadService();
const directories: string[] = [];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function directory() {
  const path = await mkdtemp(join(cache, "case-"));
  directories.push(path);
  return path;
}
async function input(name = "document.heic") {
  const dir = await directory();
  const path = join(dir, "input.heic");
  await writeFile(path, await readFile(join(fixtures, name)));
  return { dir, path, output: join(dir, "output.webp") };
}
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
beforeAll(async () => mkdir(cache, { recursive: true }));
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("HEIC canonical WebP uploads", () => {
  it("detects the actual container, normalizes once, updates MIME/name/hash/size and keeps source provenance", async () => {
    const bytes = await readFile(join(fixtures, "document.heic"));
    expect(isHeic(bytes)).toBe(true);
    const upload = await parse(bytes, "IMG_1234.HEIC");
    const file = upload.files[0];
    const canonical = await readFile(file.path);
    expect(file).toMatchObject({
      filename: "IMG_1234.webp",
      mimeType: "image/webp",
      sizeBytes: canonical.length,
      sha256: sha(canonical),
      pageCount: 1,
      source: {
        filename: "IMG_1234.HEIC",
        mimeType: "image/heic",
        sizeBytes: bytes.length,
        sha256: sha(bytes),
      },
      normalization: "heic-webp-v1",
    });
    expect(await sharp(canonical).metadata()).toMatchObject({
      format: "webp",
      width: 600,
      height: 800,
    });
    expect(await readdir(upload.directory)).not.toContain(
      `${file.id}.decoded.png`,
    );
    expect(
      (await readFile(join(fixtures, "document.heic"))).equals(bytes),
    ).toBe(true);
  });
  it("supports HEIF filenames and strips orientation/GPS after baking pixels", async () => {
    const f = await input("exif-only.heic");
    expect(hasPrimaryTransform(await readFile(f.path))).toBe(false);
    expect(exifOrientation((await sharp(f.path).metadata()).exif)).toBe(6);
    const result = await normalizeHeic(f.path, f.output);
    const metadata = await sharp(f.output).metadata();
    expect(metadata.width).toBe(800);
    expect(metadata.height).toBe(600);
    expect(result.width).toBe(800);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    const upload = await parse(
      await readFile(join(fixtures, "document.heic")),
      "photo.HeIf",
    );
    expect(upload.files[0].filename).toBe("photo.webp");
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "preserves container orientation %i without a second EXIF transform",
    async (orientation) => {
      const f = await input(`orientation-${orientation}.heic`);
      await normalizeHeic(f.path, f.output);
      const m = await sharp(f.output).metadata();
      expect([m.width, m.height]).toEqual(
        orientation >= 5 ? [800, 600] : [600, 800],
      );
      const reference = join(f.dir, "reference.png");
      execFileSync("heif-convert", ["--quiet", f.path, reference]);
      const source = await sharp(reference)
        .toColourspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer();
      const actual = await sharp(f.output).ensureAlpha().raw().toBuffer();
      expect(quality(source, actual, m.width!, m.height!).acceptable).toBe(
        true,
      );
      if (orientation !== 1)
        expect(hasPrimaryTransform(await readFile(f.path))).toBe(true);
    },
  );
  it.each(["alpha.heic", "display-p3.heic"])(
    "preserves visible pixels and alpha of %s in sRGB",
    async (name) => {
      const f = await input(name);
      const r = await normalizeHeic(f.path, f.output);
      const reference = join(f.dir, "reference.png");
      execFileSync("heif-convert", ["--quiet", f.path, reference]);
      const source = await sharp(reference)
        .toColourspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer();
      const actual = await sharp(f.output).ensureAlpha().raw().toBuffer();
      expect(quality(source, actual, r.width, r.height).acceptable).toBe(true);
      if (name === "alpha.heic")
        expect((await sharp(f.output).metadata()).hasAlpha).toBe(true);
    },
  );
  it("rejects oversized dimensions before starting native decode", async () => {
    const f = await input();
    const bytes = await readFile(f.path);
    const ispe = bytes.indexOf(Buffer.from("ispe"));
    expect(ispe).toBeGreaterThan(0);
    bytes.writeUInt32BE(10000, ispe + 8);
    bytes.writeUInt32BE(10000, ispe + 12);
    await writeFile(f.path, bytes);
    await expect(normalizeHeic(f.path, f.output)).rejects.toMatchObject({
      status: 413,
      message: "HEIC_PIXELS_LIMIT",
    });
    expect(await readdir(f.dir)).toEqual(["input.heic"]);
  });
  it("rejects multiple top-level images rather than silently dropping pages", async () => {
    const f = await input("multiple.heic");
    await expect(normalizeHeic(f.path, f.output)).rejects.toThrow(
      "HEIC_MULTIPLE_IMAGES",
    );
  });
  it("rejects truncated containers, AVIF and disguised unsupported content safely", async () => {
    const bytes = await readFile(join(fixtures, "document.heic"));
    const f = await input();
    await writeFile(f.path, bytes.subarray(0, 100));
    await expect(normalizeHeic(f.path, f.output)).rejects.toThrow(
      "HEIC_INVALID",
    );
    const avif = Buffer.from(bytes);
    avif.write("avif", 8, "ascii");
    expect(isHeic(avif)).toBe(false);
    await expect(
      parse(Buffer.from("not an image"), "photo.heic"),
    ).rejects.toThrow();
  });
  it("fails explicitly when the native HEVC decoder is unavailable", async () => {
    const f = await input();
    vi.stubEnv("PATH", f.dir);
    await expect(normalizeHeic(f.path, f.output)).rejects.toMatchObject({
      status: 503,
      message: "HEIC_DECODER_UNAVAILABLE",
    });
  });
  it("bounds concurrent conversions and releases capacity after completion", async () => {
    const a = await input(),
      b = await input();
    const pending = normalizeHeic(a.path, a.output);
    await expect(normalizeHeic(b.path, b.output)).rejects.toMatchObject({
      status: 429,
    });
    await pending;
    await expect(normalizeHeic(b.path, b.output)).resolves.toHaveProperty(
      "algorithm",
      "heic-webp-v1",
    );
  });
  it("terminates a timed out worker and releases capacity", async () => {
    const f = await input();
    vi.useFakeTimers();
    const pending = normalizeHeic(f.path, f.output);
    const assertion = expect(pending).rejects.toThrow(
      "HEIC_CONVERSION_TIMEOUT",
    );
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    vi.useRealTimers();
    await expect(normalizeHeic(f.path, f.output)).resolves.toHaveProperty(
      "algorithm",
    );
  });
  it.each([
    ["passport.jpg", "image/jpeg"],
    ["scan.png", "image/png"],
    ["document.webp", "image/webp"],
    ["multipage.pdf", "application/pdf"],
  ])("leaves existing %s byte-for-byte unchanged", async (name, mime) => {
    const bytes = await readFile(
      join(__dirname, "fixtures/approved-artifacts", name),
    );
    const upload = await parse(bytes, name);
    const file = upload.files[0];
    expect(file.mimeType).toBe(mime);
    expect(file.source).toBeUndefined();
    expect(file.sha256).toBe(sha(bytes));
    expect((await readFile(file.path)).equals(bytes)).toBe(true);
  });
});

describe("document quality guard", () => {
  it("rejects lost fine detail even on a mostly white sheet", () => {
    const w = 128,
      h = 128,
      source = Buffer.alloc(w * h * 4, 255),
      blurred = Buffer.from(source);
    for (let y = 32; y < 40; y++)
      for (let x = 8; x < 120; x++)
        if (x % 2 === 0)
          for (let c = 0; c < 3; c++) source[(y * w + x) * 4 + c] = 0;
    expect(quality(source, blurred, w, h).acceptable).toBe(false);
    expect(quality(source, source, w, h).acceptable).toBe(true);
  });
  it("rejects alpha loss", () => {
    const source = Buffer.from([255, 0, 0, 128]),
      opaque = Buffer.from([255, 0, 0, 255]);
    expect(quality(source, opaque, 1, 1).acceptable).toBe(false);
  });
});

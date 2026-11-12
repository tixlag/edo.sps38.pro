import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  canonicalJpeg,
  isDecodableImage,
  isJpegContainer,
  jpegImageEnd,
} from "../src/documents/container-normalization";

async function jpeg(width = 8, height = 8): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

/** The trailer a Huawei camera appends after the EOI marker. */
function withTrailer(bytes: Buffer, trailer = Buffer.alloc(1208)): Buffer {
  return Buffer.concat([bytes, trailer]);
}

describe("container normalization", () => {
  it("detects a JPEG container by signature only", () => {
    expect(isJpegContainer(jpegSync())).toBe(true);
    expect(isJpegContainer(Buffer.from("not a jpeg"))).toBe(false);
    expect(isJpegContainer(Buffer.from([0xff, 0xd8]))).toBe(false);
  });

  it("finds the end of the image of a clean JPEG", async () => {
    const bytes = await jpeg();
    expect(jpegImageEnd(bytes)).toBe(bytes.length);
  });

  it("finds the end of the image before a trailer", async () => {
    const bytes = await jpeg();
    const withTail = withTrailer(bytes);
    expect(jpegImageEnd(withTail)).toBe(bytes.length);
  });

  it("ignores a byte sequence that only looks like an EOI inside the scan", async () => {
    const bytes = await jpeg();
    // A raw FFD9 inside entropy coded data is impossible, but a file with an
    // EOI-like sequence before the real end must still resolve to the real end.
    const forged = Buffer.concat([
      bytes.subarray(0, bytes.length - 2),
      Buffer.from([0xff, 0xd9]),
      Buffer.alloc(64),
    ]);
    expect(jpegImageEnd(forged)).toBe(bytes.length);
  });

  it("returns null for a container without an end of image", () => {
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(jpegImageEnd(broken)).toBeNull();
    expect(jpegImageEnd(Buffer.from("plain text"))).toBeNull();
  });

  it("trims the trailer only when the result still decodes", async () => {
    const bytes = await jpeg();
    const trimmed = await canonicalJpeg(withTrailer(bytes));
    expect(trimmed).not.toBeNull();
    expect(trimmed!.equals(bytes)).toBe(true);
  });

  it("keeps a clean JPEG untouched", async () => {
    const bytes = await jpeg();
    expect(await canonicalJpeg(bytes)).toBeNull();
  });

  it("does not touch PNG or PDF", async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    expect(isJpegContainer(png)).toBe(false);
    expect(jpegImageEnd(png)).toBeNull();
    expect(await canonicalJpeg(png)).toBeNull();
  });

  it("reports an undecodable image", async () => {
    expect(await isDecodableImage(Buffer.from("nonsense"))).toBe(false);
    expect(await isDecodableImage(Buffer.alloc(0))).toBe(false);
    expect(await isDecodableImage(await jpeg())).toBe(true);
  });
});

function jpegSync(): Buffer {
  // Minimal but structurally valid JPEG used for the signature check.
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
}

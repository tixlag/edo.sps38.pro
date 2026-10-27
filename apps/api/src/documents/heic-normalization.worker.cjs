/* Native HEVC decode and WebP encoding run away from the API event loop. */
const parentPort =
  require.main === module && process.send
    ? {
        postMessage: (message) => process.send(message, () => undefined),
        once: (event, callback) => process.once(event, callback),
      }
    : null;
const { readFile, writeFile, chmod, unlink } = require("node:fs/promises");
const sharp = require("sharp");

const MAX_PIXELS = 40_000_000;
const MAX_BYTES = 10 * 1024 * 1024;
const ALGORITHM = "heic-webp-v1";

// Walk only HEIF metadata boxes, never scan compressed payload for tag names.
function boxes(bytes, start, end) {
  const result = [];
  while (start < end) {
    if (end - start < 8 || result.length >= 4096)
      throw new Error("HEIC_INVALID");
    let size = bytes.readUInt32BE(start),
      header = 8;
    if (size === 1) {
      if (end - start < 16) throw new Error("HEIC_INVALID");
      size = Number(bytes.readBigUInt64BE(start + 8));
      header = 16;
    }
    if (size === 0) size = end - start;
    if (!Number.isSafeInteger(size) || size < header || size > end - start)
      throw new Error("HEIC_INVALID");
    result.push({
      type: bytes.toString("ascii", start + 4, start + 8),
      start: start + header,
      end: start + size,
    });
    start += size;
  }
  return result;
}
function hasPrimaryTransform(bytes) {
  const meta = boxes(bytes, 0, bytes.length).find((b) => b.type === "meta");
  if (!meta) throw new Error("HEIC_INVALID");
  const children = boxes(bytes, meta.start + 4, meta.end);
  const pitm = children.find((b) => b.type === "pitm");
  const iprp = children.find((b) => b.type === "iprp");
  if (!pitm || !iprp) throw new Error("HEIC_INVALID");
  const primaryId =
    bytes[pitm.start] === 0
      ? bytes.readUInt16BE(pitm.start + 4)
      : bytes.readUInt32BE(pitm.start + 4);
  const properties = boxes(bytes, iprp.start, iprp.end);
  const ipco = properties.find((b) => b.type === "ipco");
  if (!ipco) return false;
  const types = boxes(bytes, ipco.start, ipco.end).map((b) => b.type);
  for (const ipma of properties.filter((b) => b.type === "ipma")) {
    const version = bytes[ipma.start],
      wide = (bytes[ipma.start + 3] & 1) !== 0;
    const entries = bytes.readUInt32BE(ipma.start + 4);
    let p = ipma.start + 8;
    if (entries > 4096) throw new Error("HEIC_INVALID");
    for (let n = 0; n < entries; n++) {
      const id = version < 1 ? bytes.readUInt16BE(p) : bytes.readUInt32BE(p);
      p += version < 1 ? 2 : 4;
      const count = bytes[p++];
      if (count === undefined || p + count * (wide ? 2 : 1) > ipma.end)
        throw new Error("HEIC_INVALID");
      for (let i = 0; i < count; i++) {
        const index = wide ? bytes.readUInt16BE(p) & 0x7fff : bytes[p] & 0x7f;
        p += wide ? 2 : 1;
        if (id === primaryId && ["irot", "imir"].includes(types[index - 1]))
          return true;
      }
    }
  }
  return false;
}
// libvips exposes HEIF's raw EXIF but does not populate metadata.orientation.
// Read IFD0 Orientation for legacy HEICs without an irot/imir association.
function exifOrientation(exif) {
  if (!exif) return 1;
  const start = exif.subarray(0, 6).equals(Buffer.from("Exif\0\0")) ? 6 : 0;
  const tiff = exif.subarray(start);
  const little = tiff.toString("ascii", 0, 2) === "II";
  if (tiff.length < 8 || (!little && tiff.toString("ascii", 0, 2) !== "MM"))
    throw new Error("HEIC_INVALID");
  const u16 = (p) => (little ? tiff.readUInt16LE(p) : tiff.readUInt16BE(p));
  const u32 = (p) => (little ? tiff.readUInt32LE(p) : tiff.readUInt32BE(p));
  if (u16(2) !== 42) throw new Error("HEIC_INVALID");
  const ifd = u32(4);
  if (ifd > tiff.length - 2) throw new Error("HEIC_INVALID");
  const count = u16(ifd);
  if (count > 4096 || ifd + 2 + count * 12 > tiff.length)
    throw new Error("HEIC_INVALID");
  for (let n = 0; n < count; n++) {
    const p = ifd + 2 + n * 12;
    if (u16(p) !== 0x0112) continue;
    const orientation = u16(p + 8);
    if (
      u16(p + 2) !== 3 ||
      u32(p + 4) !== 1 ||
      orientation < 1 ||
      orientation > 8
    )
      throw new Error("HEIC_INVALID");
    return orientation;
  }
  return 1;
}
function orient(image, orientation) {
  switch (orientation) {
    case 2:
      return image.flop();
    case 3:
      return image.rotate(180);
    case 4:
      return image.flip();
    case 5:
      return image.flip().rotate(90);
    case 6:
      return image.rotate(90);
    case 7:
      return image.flop().rotate(90);
    case 8:
      return image.rotate(270);
    default:
      return image;
  }
}

// Pixel comparison includes every full-resolution pixel, with an independent
// edge check so white margins cannot hide degradation of small document text.
function quality(reference, actual, width, height) {
  if (reference.length !== actual.length) return { acceptable: false };
  let squared = 0,
    edgeSquared = 0,
    edgeSamples = 0,
    samples = 0,
    ssim = 0,
    blocks = 0;
  for (let by = 0; by < height; by += 8)
    for (let bx = 0; bx < width; bx += 8) {
      let count = 0,
        x = 0,
        y = 0,
        xx = 0,
        yy = 0,
        xy = 0;
      for (let row = by; row < Math.min(by + 8, height); row++)
        for (let col = bx; col < Math.min(bx + 8, width); col++) {
          const p = (row * width + col) * 4;
          if (reference[p + 3] !== actual[p + 3]) return { acceptable: false };
          if (reference[p + 3] === 0) continue;
          const luma =
            reference[p] * 0.2126 +
            reference[p + 1] * 0.7152 +
            reference[p + 2] * 0.0722;
          const decoded =
            actual[p] * 0.2126 +
            actual[p + 1] * 0.7152 +
            actual[p + 2] * 0.0722;
          count++;
          x += luma;
          y += decoded;
          xx += luma * luma;
          yy += decoded * decoded;
          xy += luma * decoded;
          const edge =
            (col &&
              Math.abs(
                luma -
                  (reference[p - 4] * 0.2126 +
                    reference[p - 3] * 0.7152 +
                    reference[p - 2] * 0.0722),
              ) > 24) ||
            (row &&
              Math.abs(
                luma -
                  (reference[p - width * 4] * 0.2126 +
                    reference[p - width * 4 + 1] * 0.7152 +
                    reference[p - width * 4 + 2] * 0.0722),
              ) > 24);
          for (let c = 0; c < 3; c++) {
            const delta = reference[p + c] - actual[p + c];
            squared += delta * delta;
            samples++;
            if (edge) {
              edgeSquared += delta * delta;
              edgeSamples++;
            }
          }
        }
      if (count) {
        const mx = x / count,
          my = y / count;
        const vx = Math.max(0, xx / count - mx * mx),
          vy = Math.max(0, yy / count - my * my),
          cov = xy / count - mx * my;
        ssim +=
          ((2 * mx * my + 6.5025) * (2 * cov + 58.5225)) /
          ((mx * mx + my * my + 6.5025) * (vx + vy + 58.5225));
        blocks++;
      }
    }
  const mse = squared / Math.max(1, samples),
    edgeMse = edgeSquared / Math.max(1, edgeSamples);
  const score = blocks ? ssim / blocks : 1;
  return {
    acceptable: score >= 0.995 && mse <= 6.5025 && edgeMse <= 6.5025,
    ssim: score,
    psnr: mse ? 10 * Math.log10(65025 / mse) : null,
    edgeMse,
  };
}
async function normalize(input, output) {
  const bytes = await readFile(input);
  const metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
  if (metadata.format !== "heif" || metadata.compression !== "hevc")
    throw new Error("HEIC_INVALID");
  if ((metadata.pages ?? 1) !== 1) throw new Error("HEIC_MULTIPLE_IMAGES");
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_PIXELS
  )
    throw new Error("HEIC_PIXELS_LIMIT");
  const transformed = hasPrimaryTransform(bytes);
  const png = `${input}.decoded.png`;
  try {
    await new Promise((resolve, reject) => {
      parentPort.once("message", (message) =>
        message.decoded ? resolve() : reject(new Error(message.error)),
      );
      parentPort.postMessage({ decode: true });
    });
    await chmod(png, 0o600);
    const image = orient(
      sharp(png, { limitInputPixels: MAX_PIXELS, failOn: "warning" }),
      transformed
        ? 1
        : (metadata.orientation ?? exifOrientation(metadata.exif)),
    );
    // PNG retains the HEIF colour profile; sharp converts it to standard sRGB.
    // EXIF/GPS are not propagated; orientation is baked into these pixels once.
    const { data, info } = await image
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .timeout({ seconds: 15 })
      .toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: 4 };
    let best = await sharp(data, { raw })
      .webp({ lossless: true, exact: true, effort: 6 })
      .timeout({ seconds: 15 })
      .toBuffer();
    let selected = "lossless",
      metrics = { acceptable: true, ssim: 1, psnr: null, edgeMse: 0 };
    for (const [mode, options] of [
      ["near-lossless-80", { nearLossless: true, quality: 80, effort: 6 }],
      [
        "quality-92",
        { quality: 92, alphaQuality: 100, smartSubsample: true, effort: 6 },
      ],
    ]) {
      const candidate = await sharp(data, { raw })
        .webp(options)
        .timeout({ seconds: 15 })
        .toBuffer();
      if (candidate.length >= best.length) continue;
      const actual = await sharp(candidate).ensureAlpha().raw().toBuffer();
      const measured = quality(data, actual, info.width, info.height);
      if (measured.acceptable) {
        best = candidate;
        selected = mode;
        metrics = measured;
      }
    }
    if (best.length > MAX_BYTES) throw new Error("HEIC_OUTPUT_LIMIT");
    await writeFile(output, best, { mode: 0o600, flag: "wx" });
    return {
      algorithm: ALGORITHM,
      mode: selected,
      width: info.width,
      height: info.height,
      sizeBytes: best.length,
      ...metrics,
    };
  } finally {
    await unlink(png).catch(() => undefined);
  }
}
if (parentPort) {
  // The cache is process-local; no libvips state is shared with the API.
  sharp.cache(false);
  process.once("disconnect", () => process.exit(1));
  normalize(process.argv[2], process.argv[3]).then(
    (result) => parentPort.postMessage({ result }),
    (error) =>
      parentPort.postMessage({
        error: /^HEIC_[A-Z_]+$/.test(error.message)
          ? error.message
          : "HEIC_INVALID",
      }),
  );
}
module.exports = { quality, hasPrimaryTransform, exifOrientation, orient };

import sharp from "sharp";

/**
 * Container normalization for uploaded originals.
 *
 * Some cameras (Huawei/HarmonyOS "ctrace") append a non-image trailer AFTER the
 * JPEG EOI marker. 1C validates the container strictly and requires the file to
 * END at the end-of-image marker, so such files are rejected with
 * INVALID_FILE_CONTENT. EDO stores what the candidate uploaded, so the trailer
 * has to be removed before the file is delivered to ERP.
 *
 * The module only analyses the container structure; every decode check is a
 * separate async function (a synchronous structural check must never stand in
 * for a real decode).
 */

/** JPEG container detected by signature, never by a client supplied MIME type. */
export function isJpegContainer(bytes: Buffer): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

/**
 * Offset (exclusive) of the end of the JPEG image: the EOI marker that
 * terminates the last scan.
 *
 * Walks the real marker structure instead of searching for the last "FFD9":
 * entropy coded data after SOS is skipped (0xFF00 byte stuffing and RSTn
 * markers are not real markers), so progressive JPEGs with several scans are
 * handled correctly.
 *
 * Returns null when no valid end of image can be located.
 */
export function jpegImageEnd(bytes: Buffer): number | null {
  if (!isJpegContainer(bytes)) return null;
  const size = bytes.length;
  let pos = 2; // after SOI
  while (pos + 1 < size) {
    if (bytes[pos] !== 0xff) return null; // not a marker boundary
    let marker = bytes[pos + 1];
    while (marker === 0xff && pos + 2 < size) {
      pos += 1; // fill bytes
      marker = bytes[pos + 1];
    }
    if (marker === 0xd9) return pos + 2; // EOI
    if (marker === 0xda) {
      // Start of scan: skip the header, then the entropy coded data.
      if (pos + 4 > size) return null;
      const length = bytes.readUInt16BE(pos + 2);
      if (length < 2 || pos + 2 + length > size) return null;
      let scan = pos + 2 + length;
      while (scan + 1 < size) {
        if (bytes[scan] !== 0xff) {
          scan += 1;
          continue;
        }
        const next = bytes[scan + 1];
        if (next === 0x00) {
          scan += 2; // stuffed byte
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          scan += 2; // restart marker
          continue;
        }
        break; // a real marker follows the scan
      }
      pos = scan;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // markers without a length field
      continue;
    }
    if (pos + 4 > size) return null;
    const length = bytes.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > size) return null;
    pos += 2 + length;
  }
  return null;
}

/**
 * True when the bytes decode as a single still image. `stats()` decodes the
 * pixels, unlike `metadata()` alone which happily accepts truncated images.
 */
export async function isDecodableImage(bytes: Buffer): Promise<boolean> {
  if (!bytes.length) return false;
  try {
    const image = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1) return false;
    await image.timeout({ seconds: 10 }).stats();
    return true;
  } catch {
    return false;
  }
}

/**
 * JPEG without the trailing non-image bytes, or null when the file cannot be
 * trimmed safely (no end of image found, nothing to trim, or the trimmed bytes
 * do not decode).
 */
export async function canonicalJpeg(bytes: Buffer): Promise<Buffer | null> {
  const end = jpegImageEnd(bytes);
  if (end === null || end >= bytes.length) return null;
  const trimmed = bytes.subarray(0, end);
  if (!(await isDecodableImage(trimmed))) return null;
  return trimmed;
}

/** Synthetic documents only, deterministic pixels; no real personal data. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

async function main() {
  const directory = join(__dirname, "../test/fixtures/approved-artifacts");
  await mkdir(directory, { recursive: true });
  let state = 1234567;
  const w = 1200,
    h = 900;
  const pixels = Buffer.alloc(w * h * 3);
  for (let i = 0; i < pixels.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = 210 + (state % 40);
  }
  const lines = Array.from(
    { length: 24 },
    (_, i) =>
      `<text x="45" y="${130 + i * 24}" font-size="14">SYNTHETIC DOCUMENT LINE ${i + 1} / 0123456789 / Signature and fine print</text>`,
  ).join("");
  // This is a real QR matrix for the text EDO-ARTIFACT-READABILITY-2026.
  const qr = (await import("node:fs/promises")).readFile(
    join(directory, "qr.svg"),
  );
  const overlay = Buffer.from(
    `<svg width="1200" height="900"><rect x="22" y="24" width="1155" height="850" fill="none" stroke="#333"/><text x="45" y="80" font-size="30">SYNTHETIC PASSPORT / NOT A REAL DOCUMENT</text>${lines}<circle cx="980" cy="660" r="110" fill="none" stroke="#804080" stroke-width="3"/><text x="904" y="660" fill="#804080" font-size="18">TEST STAMP</text><path d="M60 820 q30 -70 50 0 q20 -100 35 -10 t80 -20" fill="none" stroke="#243b70" stroke-width="3"/></svg>`,
  );
  const source = sharp(pixels, {
    raw: { width: w, height: h, channels: 3 },
  }).composite([{ input: overlay }, { input: await qr, left: 850, top: 160 }]);
  const files: Record<string, Buffer> = {
    "passport.jpg": await source
      .clone()
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer(),
    "text-photo.jpg": await source.clone().jpeg({ quality: 85 }).toBuffer(),
    "scan.png": await source.clone().png().toBuffer(),
    "document.webp": await source.clone().webp({ quality: 92 }).toBuffer(),
    "transparent.png": await sharp(
      Buffer.from(
        '<svg width="160" height="240"><rect x="20" y="20" width="120" height="200" fill="red" fill-opacity="0.5"/><text x="25" y="60" font-size="14">ALPHA TEST</text></svg>',
      ),
    )
      .png()
      .toBuffer(),
  };
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date("2026-10-22T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-10-22T00:00:00Z"));
  for (const [width, height] of [
    [210, 297],
    [300, 400],
    [500, 200],
  ]) {
    const page = pdf.addPage([width, height]);
    page.drawText(`PAGE ${pdf.getPageCount()}`, { x: 20, y: 40, size: 18 });
  }
  files["multipage.pdf"] = Buffer.from(await pdf.save());
  const manifest: Record<string, object> = {};
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(directory, name), bytes);
    manifest[name] = {
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
void main();

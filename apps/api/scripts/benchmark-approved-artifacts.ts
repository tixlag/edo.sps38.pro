import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mergeDocumentPdf } from "../src/documents/document-pdf.service";

/** Reproduces the previous algorithm for measurement only. */
async function oldPdf(files: { mimeType: string; bytes: Buffer }[]) {
  if (files.length === 1 && files[0].mimeType === "application/pdf")
    return files[0].bytes;
  const pdf = await PDFDocument.create();
  for (const f of files) {
    if (f.mimeType === "application/pdf") {
      const src = await PDFDocument.load(f.bytes);
      for (const page of await pdf.copyPages(src, src.getPageIndices()))
        pdf.addPage(page);
    } else {
      const image = await pdf.embedPng(
        await sharp(f.bytes).rotate().png().toBuffer(),
      );
      pdf
        .addPage([image.width, image.height])
        .drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });
    }
  }
  return Buffer.from(await pdf.save());
}
async function main() {
  const fixtures = join(__dirname, "../test/fixtures/approved-artifacts");
  const out = join(__dirname, "../../../.cache/approved-artifacts/benchmark");
  await mkdir(out, { recursive: true });
  const mime = (name: string) =>
    name.endsWith("jpg")
      ? "image/jpeg"
      : name.endsWith("png")
        ? "image/png"
        : name.endsWith("webp")
          ? "image/webp"
          : "application/pdf";
  const cases = [
    ["passport-photo", "passport.jpg"],
    ["text-photo", "text-photo.jpg"],
    ["png-scan", "scan.png"],
    ["webp", "document.webp"],
    ["passport-two-sides", "passport.jpg", "text-photo.jpg"],
    ["pdf-and-photo", "multipage.pdf", "passport.jpg"],
  ];
  const results = [];
  for (const [name, ...names] of cases) {
    const files = await Promise.all(
      names.map(async (n) => ({
        mimeType: mime(n),
        bytes: await readFile(join(fixtures, n)),
      })),
    );
    const previous = await oldPdf(files);
    const next =
      files.length === 1 ? files[0].bytes : await mergeDocumentPdf(files);
    await writeFile(join(out, `${name}-old.pdf`), previous);
    await writeFile(
      join(
        out,
        `${name}-new.${files.length === 1 ? names[0].split(".").at(-1) : "pdf"}`,
      ),
      next,
    );
    results.push({
      name,
      inputBytes: files.reduce((n, f) => n + f.bytes.length, 0),
      oldBytes: previous.length,
      newBytes: next.length,
      savingPercent: Number(
        ((1 - next.length / previous.length) * 100).toFixed(2),
      ),
    });
  }
  const orientations = [];
  const source = await readFile(join(fixtures, "passport.jpg"));
  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = await sharp(source)
      .withMetadata({ orientation })
      .jpeg({ quality: 92 })
      .toBuffer();
    const pdf = await mergeDocumentPdf([{ bytes, mimeType: "image/jpeg" }]);
    const path = join(out, `orientation-${orientation}`);
    await writeFile(`${path}.pdf`, pdf);
    execFileSync("pdftoppm", [
      "-singlefile",
      "-r",
      "72",
      "-png",
      `${path}.pdf`,
      path,
    ]);
    const expected = await sharp(bytes)
      .rotate()
      .resize(300, 300, { fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const actual = await sharp(`${path}.png`)
      .resize(300, 300, { fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      expected.info.width !== actual.info.width ||
      expected.info.height !== actual.info.height
    )
      throw new Error("Orientation dimensions differ");
    let sum = 0;
    for (let i = 0; i < actual.data.length; i++)
      sum += Math.abs(actual.data[i] - expected.data[i]);
    const meanAbsoluteError = sum / actual.data.length;
    if (meanAbsoluteError > 5)
      throw new Error(
        `Orientation ${orientation}: raster mismatch ${meanAbsoluteError}`,
      );
    orientations.push({
      orientation,
      width: actual.info.width,
      height: actual.info.height,
      meanAbsoluteError,
    });
  }
  // Alpha on a white PDF background is a separate raster case.
  const alpha = await readFile(join(fixtures, "transparent.png"));
  await writeFile(
    join(out, "alpha.pdf"),
    await mergeDocumentPdf([{ bytes: alpha, mimeType: "image/png" }]),
  );
  execFileSync("pdftoppm", [
    "-singlefile",
    "-r",
    "72",
    "-png",
    join(out, "alpha.pdf"),
    join(out, "alpha"),
  ]);
  const expected = await sharp(alpha)
    .flatten({ background: "white" })
    .raw()
    .toBuffer();
  const actual = await sharp(join(out, "alpha.png"))
    .removeAlpha()
    .raw()
    .toBuffer();
  let alphaError = 0;
  for (let i = 0; i < actual.length; i++)
    alphaError += Math.abs(actual[i] - expected[i]);
  alphaError /= actual.length;
  if (alphaError > 5) throw new Error(`Alpha mismatch ${alphaError}`);
  await writeFile(
    join(out, "measurements.json"),
    JSON.stringify(
      {
        node: process.version,
        results,
        orientations,
        alphaMeanAbsoluteError: alphaError,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify(
      { results, orientations, alphaMeanAbsoluteError: alphaError },
      null,
      2,
    ) + "\n",
  );
}
void main();

/** Synthetic HEVC fixtures; requires libheif-tools (heif-enc with x265). */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import sharp from "sharp";

async function main() {
  const out = join(__dirname, "../test/fixtures/heic");
  const cache = join(__dirname, "../../../.cache/heic/fixture-generation");
  await mkdir(out, { recursive: true });
  await mkdir(cache, { recursive: true });
  const qr = await readFile(
    join(__dirname, "../test/fixtures/approved-artifacts/qr.svg"),
  );
  const svg = Buffer.from(
    `<svg width="600" height="800"><rect width="600" height="800" fill="white"/><rect x="5" y="5" width="590" height="790" fill="none" stroke="black" stroke-width="4"/><text x="20" y="40" font-size="20">HEIC SYNTHETIC DOCUMENT</text>${Array.from({ length: 25 }, (_, i) => `<text x="20" y="${90 + i * 23}" font-size="12">LINE ${i + 1}: 0123456789 ABCDEFGH Fine text</text>`).join("")}<circle cx="475" cy="665" r="75" fill="none" stroke="#803080" stroke-width="3"/><text x="435" y="665" font-size="12" fill="#803080">STAMP</text><path d="M30 750 q30 -65 60 0 t100 -10" stroke="#235090" fill="none" stroke-width="3"/><rect x="10" y="10" width="30" height="10" fill="red"/><rect x="560" y="760" width="20" height="25" fill="blue"/></svg>`,
  );
  const png = await sharp(svg)
    .composite([{ input: qr, left: 370, top: 110 }])
    .png()
    .toBuffer();
  const source = join(cache, "source.png");
  await writeFile(source, png);
  const manifest: Record<string, object> = {};
  function encode(name: string, inputs: string[], options: string[] = []) {
    const path = join(out, name);
    const args = [
      "-q",
      "90",
      "-p",
      "x265:pools=1",
      "-p",
      "x265:frame-threads=1",
      ...options,
      "-o",
      path,
      ...inputs,
    ];
    const image = process.env.HEIF_ENCODER_CONTAINER;
    const root = join(__dirname, "../../..");
    if (image)
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          "-v",
          `${root}:${root}`,
          "-w",
          root,
          image,
          "heif-enc",
          ...args,
        ],
        { stdio: "ignore" },
      );
    else execFileSync("heif-enc", args, { stdio: "ignore" });
  }
  encode("document.heic", [source]);
  for (let orientation = 1; orientation <= 8; orientation++) {
    const operations: Record<number, string[]> = {
      1: [],
      2: ["--flip-h"],
      3: ["--rotate-cw", "180"],
      4: ["--flip-v"],
      5: ["--rotate-cw", "90", "--flip-v"],
      6: ["--rotate-cw", "90"],
      7: ["--rotate-cw", "90", "--flip-h"],
      8: ["--rotate-cw", "270"],
    };
    encode(
      `orientation-${orientation}.heic`,
      [source],
      operations[orientation],
    );
  }
  const alpha = join(cache, "alpha.png");
  await writeFile(
    alpha,
    await sharp(
      Buffer.from(
        '<svg width="160" height="200"><rect x="20" y="20" width="120" height="160" fill="red" opacity="0.5"/></svg>',
      ),
    )
      .png()
      .toBuffer(),
  );
  encode("alpha.heic", [alpha]);
  encode("multiple.heic", [source, alpha]);
  const exif = join(cache, "orientation.exif");
  const metadata = await sharp(
    await sharp(png).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
  ).metadata();
  await writeFile(exif, metadata.exif!);
  execFileSync("python3", [
    join(__dirname, "add-heic-exif-fixture.py"),
    source,
    exif,
    join(out, "exif-only.heic"),
  ]);
  const p3 = join(cache, "p3.png");
  await writeFile(p3, await sharp(png).withIccProfile("p3").png().toBuffer());
  encode("display-p3.heic", [p3]);
  for (const name of [
    "document.heic",
    ...Array.from({ length: 8 }, (_, i) => `orientation-${i + 1}.heic`),
    "alpha.heic",
    "multiple.heic",
    "exif-only.heic",
    "display-p3.heic",
  ]) {
    const bytes = await readFile(join(out, name));
    manifest[name] = {
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await writeFile(
    join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
void main();

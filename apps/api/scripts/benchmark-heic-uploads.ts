import "reflect-metadata";
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import sharp from "sharp";
import { normalizeHeic } from "../src/documents/heic-normalization";

async function main() {
  const out = join(__dirname, "../../../.cache/heic/benchmark");
  await mkdir(out, { recursive: true });
  const results = [];
  for (const name of [
    "document.heic",
    "orientation-6.heic",
    "alpha.heic",
    "display-p3.heic",
    "exif-only.heic",
  ]) {
    const input = join(out, name);
    await copyFile(join(__dirname, "../test/fixtures/heic", name), input);
    const output = `${input}.webp`,
      decoded = `${input}.reference.png`;
    execFileSync("heif-convert", ["--quiet", input, decoded]);
    await rm(output, { force: true });
    const result = await normalizeHeic(input, output);
    const m = await sharp(output).metadata();
    const originalBytes = (await readFile(input)).length,
      webpBytes = (await readFile(output)).length;
    results.push({
      name,
      originalBytes,
      webpBytes,
      changePercent: Number(((webpBytes / originalBytes - 1) * 100).toFixed(2)),
      width: m.width,
      height: m.height,
      ...result,
    });
  }
  await writeFile(
    join(out, "measurements.json"),
    JSON.stringify({ node: process.version, results }, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
}
void main();

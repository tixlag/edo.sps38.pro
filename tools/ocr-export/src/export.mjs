import { createHash } from "node:crypto";
import { mkdir, writeFile, rename, stat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const require = createRequire(import.meta.url);
const MAX_PIXELS = 40_000_000;
const MAX_BYTES = 100 * 1024 * 1024;
export const RENDER_PROFILE =
  "upright-v1-pdfjs5.6.205-canvas0.1.100-sharp0.35.5-200dpi";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw new Error(code);
};

function checkSize(width, height) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_PIXELS ||
    width > 65536 ||
    height > 65536
  )
    fail("PAGE_SIZE_LIMIT");
}

/** Same upright source frame as the API: original EXIF, PDF crop box and /Rotate. */
export async function canonicalPage(bytes, metadata) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES)
    fail("SOURCE_SIZE_LIMIT");
  if (!Number.isInteger(metadata.pageNumber) || metadata.pageNumber < 1)
    fail("INVALID_PAGE");
  if (metadata.mimeType === "application/pdf") {
    const { getDocument, AnnotationMode } =
      await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfBase = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const loading = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: path.join(pdfBase, "standard_fonts/"),
      cMapUrl: path.join(pdfBase, "cmaps/"),
      cMapPacked: true,
      wasmUrl: path.join(pdfBase, "wasm/"),
    });
    let render, timer;
    try {
      const document = await loading.promise;
      if (document.numPages > 100 || metadata.pageNumber > document.numPages)
        fail("INVALID_PAGE");
      const page = await document.getPage(metadata.pageNumber);
      const viewport = page.getViewport({ scale: 200 / 72 });
      const width = Math.ceil(viewport.width),
        height = Math.ceil(viewport.height);
      checkSize(width, height);
      const canvas = createCanvas(width, height);
      render = page.render({
        canvasContext: canvas.getContext("2d"),
        canvas,
        viewport,
        annotationMode: AnnotationMode.ENABLE,
        background: "rgb(255,255,255)",
      });
      await Promise.race([
        render.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            render.cancel();
            reject(new Error("PDF_RENDER_TIMEOUT"));
          }, 30_000);
        }),
      ]);
      return { width, height, png: canvas.toBuffer("image/png") };
    } finally {
      clearTimeout(timer);
      await loading.destroy();
    }
  }
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(metadata.mimeType) ||
    metadata.pageNumber !== 1
  )
    fail("UNSUPPORTED_SOURCE");
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
    .timeout({ seconds: 30 })
    .rotate()
    .toColourspace("srgb")
    .png()
    .toBuffer({ resolveWithObject: true });
  checkSize(info.width, info.height);
  return { width: info.width, height: info.height, png: data };
}

function rectangle(quad, width, height) {
  if (
    !Array.isArray(quad) ||
    quad.length !== 8 ||
    quad.some((n) => !Number.isFinite(n) || n < 0 || n > 1)
  )
    fail("INVALID_QUAD");
  const p = Array.from({ length: 4 }, (_, i) => ({
    x: quad[2 * i] * width,
    y: quad[2 * i + 1] * height,
  }));
  const u = { x: p[1].x - p[0].x, y: p[1].y - p[0].y },
    v = { x: p[3].x - p[0].x, y: p[3].y - p[0].y };
  const w = Math.hypot(u.x, u.y),
    h = Math.hypot(v.x, v.y);
  if (
    w < 1 ||
    h < 1 ||
    u.x * v.y - u.y * v.x <= 0 ||
    Math.abs(u.x * v.x + u.y * v.y) > 0.5 * Math.min(w, h) ||
    Math.abs(p[2].x - (p[0].x + u.x + v.x)) > 0.5 ||
    Math.abs(p[2].y - (p[0].y + u.y + v.y)) > 0.5
  )
    fail("INVALID_RECTANGLE");
  return { origin: p[0], u, v, w, h };
}

/** Rectify the actual oriented rectangle; each crop contains one literal line. */
export async function cropLine(page, quad) {
  const { origin, u, v, w, h } = rectangle(quad, page.width, page.height);
  const width = Math.max(1, Math.round(w)),
    height = Math.max(1, Math.round(h));
  checkSize(width, height);
  const canvas = createCanvas(width, height),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  const ux = u.x / w,
    uy = u.y / w,
    vx = v.x / h,
    vy = v.y / h,
    sx = width / w,
    sy = height / h;
  context.setTransform(
    ux * sx,
    vx * sy,
    uy * sx,
    vy * sy,
    -(ux * origin.x + uy * origin.y) * sx,
    -(vx * origin.x + vy * origin.y) * sy,
  );
  context.drawImage(await loadImage(page.png), 0, 0);
  return canvas.toBuffer("image/png");
}

function collect(record) {
  if (record.status !== "ACCEPTED") fail("UNACCEPTED_SNAPSHOT");
  const { annotation, schema, sources, fields } = record.payload ?? {};
  if (
    !annotation?.id ||
    !annotation.documentId ||
    !annotation.versionId ||
    !schema?.id ||
    !sources?.pages?.length ||
    !Array.isArray(fields)
  )
    fail("INVALID_SNAPSHOT");
  const tasks = [],
    seen = new Set();
  for (const definition of [...schema.fields].sort(
    (a, b) => a.ordinal - b.ordinal,
  )) {
    const answer = fields.find((f) => f.key === definition.key);
    if (
      !answer ||
      !["PRESENT", "NOT_PRESENT", "UNREADABLE"].includes(answer.disposition)
    )
      fail("INCOMPLETE_SNAPSHOT");
    if (answer.disposition !== "PRESENT") {
      if (answer.lines?.length) fail("INVALID_DISPOSITION");
      continue;
    }
    if (
      !answer.lines?.length ||
      (!definition.multiline && answer.lines.length > 1)
    )
      fail("INCOMPLETE_LINES");
    for (const line of [...answer.lines].sort((a, b) => a.order - b.order)) {
      if (
        typeof line.text !== "string" ||
        !line.text.trim() ||
        line.text.length > 2000 ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line.text)
      )
        fail("INVALID_TRANSCRIPTION");
      if (seen.has(line.id) || !Number.isInteger(line.order) || line.order < 0)
        fail("INVALID_LINE_ORDER");
      seen.add(line.id);
      const source = sources.pages.find((p) => p.id === line.pageId);
      if (
        !source ||
        source.frame !== "UPRIGHT_PIXELS_V1" ||
        source.renderDpi !== 200 ||
        !/^[a-f0-9]{64}$/u.test(source.sha256)
      )
        fail("INVALID_SOURCE_FRAME");
      rectangle(line.quad, source.width, source.height);
      tasks.push({ line, source, definition, index: tasks.length });
    }
  }
  return { annotation, schema, sources, tasks };
}

/** readSource is injected by the operator CLI and uses existing private StorageService. */
export async function exportAccepted({
  records,
  outputDir,
  readSource,
  dryRun = false,
}) {
  if (!Array.isArray(records) || !records.length || records.length > 1000)
    fail("EXPORT_LIMIT");
  const target = path.resolve(outputDir);
  const assertUnpublished = async () => {
    for (const name of [
      "manifest.jsonl",
      "snapshots.jsonl",
      "labels.txt",
      "COMPLETE.json",
    ]) {
      if (
        await stat(path.join(target, name)).then(
          () => true,
          () => false,
        )
      )
        fail("OUTPUT_ALREADY_EXISTS");
    }
  };
  await assertUnpublished();
  const manifests = [],
    labels = [],
    snapshots = [];
  if (!dryRun) await mkdir(target, { recursive: true, mode: 0o700 });
  const lock = path.join(target, ".export.lock");
  const reservation = dryRun
    ? null
    : await open(lock, "wx", 0o600).catch(() => fail("EXPORT_ALREADY_RUNNING"));
  try {
    await assertUnpublished();
    let lineCount = 0;
    for (const record of [...records].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const { annotation, schema, sources, tasks } = collect(record);
      // Every pinned original must still exist, even if every field was marked
      // absent/unreadable and no training crop will be generated from that file.
      const verifiedFiles = new Set();
      for (const source of sources.pages) {
        if (verifiedFiles.has(source.fileId)) continue;
        const bytes = await readSource(source, record);
        if (
          !Buffer.isBuffer(bytes) ||
          bytes.length !== source.sizeBytes ||
          sha256(bytes) !== source.sha256
        )
          fail("SOURCE_HASH_MISMATCH");
        verifiedFiles.add(source.fileId);
      }
      snapshots.push(
        JSON.stringify({
          formatVersion: 1,
          renderProfile: RENDER_PROFILE,
          snapshot: {
            id: record.id,
            revision: record.revision,
            status: record.status,
          },
          annotation,
          schema,
          sources: {
            ...sources,
            pages: sources.pages.map(
              ({ storageKey: _key, previewUrl: _url, ...page }) => page,
            ),
          },
          fields: record.payload.fields,
        }),
      );
      const recordKey = sha256(
        Buffer.from(`${record.id}:${record.revision}`),
      ).slice(0, 24);
      const rows = new Array(tasks.length);
      for (const pageId of new Set(tasks.map((t) => t.source.id))) {
        const pageTasks = tasks.filter((t) => t.source.id === pageId),
          source = pageTasks[0].source;
        const bytes = await readSource(source, record);
        if (
          !Buffer.isBuffer(bytes) ||
          bytes.length !== source.sizeBytes ||
          sha256(bytes) !== source.sha256
        )
          fail("SOURCE_HASH_MISMATCH");
        const page = await canonicalPage(bytes, source);
        if (page.width !== source.width || page.height !== source.height)
          fail("SOURCE_FRAME_MISMATCH");
        const pageKey = sha256(
          Buffer.from(
            `${source.sha256}:${source.pageNumber}:${RENDER_PROFILE}`,
          ),
        ).slice(0, 32);
        const pagePath = `pages/${pageKey}.png`;
        if (!dryRun) {
          await mkdir(path.join(target, "pages"), {
            recursive: true,
            mode: 0o700,
          });
          await writeFile(path.join(target, pagePath), page.png, {
            mode: 0o600,
          });
          await mkdir(path.join(target, "lines"), {
            recursive: true,
            mode: 0o700,
          });
        }
        for (const task of pageTasks) {
          const crop = await cropLine(page, task.line.quad);
          const cropPath = `lines/${recordKey}-${String(task.index).padStart(4, "0")}.png`;
          if (!dryRun)
            await writeFile(path.join(target, cropPath), crop, { mode: 0o600 });
          rows[task.index] = {
            formatVersion: 1,
            renderProfile: RENDER_PROFILE,
            snapshot: { id: record.id, revision: record.revision },
            annotation,
            schema: {
              id: schema.id,
              version: schema.version,
              documentTypeCode: schema.documentTypeCode,
              profile: schema.profile,
            },
            field: { key: task.definition.key, label: task.definition.label },
            source: {
              fileId: source.fileId,
              pageNumber: source.pageNumber,
              sha256: source.sha256,
              width: page.width,
              height: page.height,
              frame: source.frame,
              pagePath,
              pageSha256: sha256(page.png),
            },
            line: {
              id: task.line.id,
              order: task.line.order,
              quad: task.line.quad,
            },
            transcription: task.line.text,
            cropPath,
            cropSha256: sha256(crop),
            splitGroup: annotation.candidateCode1c
              ? `person:${annotation.candidateCode1c}`
              : annotation.candidateId
                ? `candidate:${annotation.candidateId}`
                : `document:${annotation.documentId}`,
          };
        }
      }
      for (const row of rows) {
        manifests.push(JSON.stringify(row));
        labels.push(`${row.cropPath}\t${row.transcription}`);
        lineCount++;
      }
    }
    const result = {
      snapshots: records.length,
      lines: lineCount,
      renderProfile: RENDER_PROFILE,
    };
    if (!dryRun) {
      // Publication marker is written last. A failed run never claims a complete export.
      await writeFile(
        path.join(target, "labels.txt.partial"),
        `${labels.join("\n")}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        path.join(target, "manifest.jsonl.partial"),
        `${manifests.join("\n")}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        path.join(target, "snapshots.jsonl.partial"),
        `${snapshots.join("\n")}\n`,
        { mode: 0o600 },
      );
      await rename(
        path.join(target, "labels.txt.partial"),
        path.join(target, "labels.txt"),
      );
      await rename(
        path.join(target, "manifest.jsonl.partial"),
        path.join(target, "manifest.jsonl"),
      );
      await rename(
        path.join(target, "snapshots.jsonl.partial"),
        path.join(target, "snapshots.jsonl"),
      );
      await writeFile(
        path.join(target, "COMPLETE.json"),
        JSON.stringify(result) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    }
    return result;
  } finally {
    if (reservation) {
      await reservation.close();
      await unlink(lock);
    }
  }
}

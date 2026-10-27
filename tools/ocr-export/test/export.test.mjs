import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, rgb, degrees } from "pdf-lib";
import { canonicalPage, cropLine, exportAccepted } from "../src/export.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = path.resolve("../../.cache/review-annotations");

async function fixture() {
  const bytes = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "white" },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 50, height: 10, channels: 3, background: "red" },
        })
          .png()
          .toBuffer(),
        left: 10,
        top: 10,
      },
      {
        input: await sharp({
          create: { width: 50, height: 10, channels: 3, background: "blue" },
        })
          .png()
          .toBuffer(),
        left: 10,
        top: 40,
      },
    ])
    .png()
    .toBuffer();
  const pages = [
    {
      id: "page1",
      fileId: "file1",
      pageNumber: 1,
      width: 100,
      height: 80,
      sha256: hash(bytes),
      sizeBytes: bytes.length,
      mimeType: "image/png",
      frame: "UPRIGHT_PIXELS_V1",
      renderDpi: 200,
    },
  ];
  const record = {
    id: "snap1",
    annotationId: "ann1",
    revision: 3,
    status: "ACCEPTED",
    payload: {
      annotation: {
        id: "ann1",
        versionId: "v1",
        documentId: "d1",
        authorId: "a1",
        catalogId: "cat1",
        revision: 3,
      },
      schema: {
        id: "cat1",
        version: 1,
        documentTypeCode: "PASSPORT",
        profile: "RU",
        fields: [{ key: "name", label: "Имя", ordinal: 0, multiline: true }],
      },
      sources: { pages },
      fields: [
        {
          key: "name",
          disposition: "PRESENT",
          lines: [
            {
              id: "line1",
              pageId: "page1",
              order: 0,
              text: "ИВАН",
              quad: [0.1, 0.125, 0.6, 0.125, 0.6, 0.25, 0.1, 0.25],
            },
            {
              id: "line2",
              pageId: "page1",
              order: 1,
              text: "ИВАНОВ",
              quad: [0.1, 0.5, 0.6, 0.5, 0.6, 0.625, 0.1, 0.625],
            },
          ],
        },
      ],
    },
  };
  return { bytes, record };
}

test("exports one image and exact literal label per visual line, with provenance", async () => {
  const { bytes, record } = await fixture();
  const dir = await mkdtemp(path.join(scratch, "export-test-"));
  try {
    const result = await exportAccepted({
      records: [record],
      outputDir: dir,
      readSource: async () => bytes,
    });
    assert.equal(result.lines, 2);
    const labels = (await readFile(path.join(dir, "labels.txt"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(labels.length, 2);
    assert.equal(labels[0].split("\t")[1], "ИВАН");
    assert.equal(labels[1].split("\t")[1], "ИВАНОВ");
    const [first, second] = await Promise.all(
      labels.map(async (label) =>
        sharp(path.join(dir, label.split("\t")[0]))
          .raw()
          .toBuffer({ resolveWithObject: true }),
      ),
    );
    assert.deepEqual([first.info.width, first.info.height], [50, 10]);
    assert.ok(first.data[0] > 240 && first.data[2] < 10);
    assert.ok(second.data[2] > 240 && second.data[0] < 10);
    const manifest = (await readFile(path.join(dir, "manifest.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const snapshots = (
      await readFile(path.join(dir, "snapshots.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(snapshots[0].schema, record.payload.schema);
    assert.deepEqual(snapshots[0].fields, record.payload.fields);
    assert.equal(manifest[0].source.sha256, hash(bytes));
    assert.equal(manifest[0].annotation.versionId, "v1");
    assert.equal(manifest[0].schema.version, 1);
    assert.equal(manifest[0].transcription, "ИВАН");
    assert.equal(manifest[0].splitGroup, "document:d1");
    await access(path.join(dir, manifest[0].source.pagePath));
    const rerun = await mkdtemp(path.join(scratch, "export-test-"));
    try {
      await exportAccepted({
        records: [record],
        outputDir: rerun,
        readSource: async () => bytes,
      });
      assert.equal(
        await readFile(path.join(rerun, "manifest.jsonl"), "utf8"),
        await readFile(path.join(dir, "manifest.jsonl"), "utf8"),
      );
    } finally {
      await rm(rerun, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects unaccepted snapshots and mismatched source hashes without publishing a manifest", async () => {
  const { record } = await fixture();
  for (const candidate of [{ ...record, status: "SUBMITTED" }, record]) {
    const dir = await mkdtemp(path.join(scratch, "export-test-"));
    try {
      await assert.rejects(
        exportAccepted({
          records: [candidate],
          outputDir: dir,
          readSource: async () => Buffer.from("changed"),
        }),
      );
      await assert.rejects(access(path.join(dir, "manifest.jsonl")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("dry run checks actual sources but creates no crops", async () => {
  const { bytes, record } = await fixture();
  const dir = await mkdtemp(path.join(scratch, "export-test-"));
  try {
    const result = await exportAccepted({
      records: [record],
      outputDir: dir,
      readSource: async () => bytes,
      dryRun: true,
    });
    assert.equal(result.lines, 2);
    await assert.rejects(access(path.join(dir, "labels.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepted absent or unreadable fields produce no fabricated training examples", async () => {
  const { record, bytes } = await fixture();
  record.payload.fields = [
    { key: "name", disposition: "UNREADABLE", lines: [] },
  ];
  const dir = await mkdtemp(path.join(scratch, "export-test-"));
  try {
    const result = await exportAccepted({
      records: [record],
      outputDir: dir,
      readSource: async () => bytes,
    });
    assert.equal(result.lines, 0);
    assert.equal(await readFile(path.join(dir, "labels.txt"), "utf8"), "\n");
    const accepted = JSON.parse(
      await readFile(path.join(dir, "snapshots.jsonl"), "utf8"),
    );
    assert.equal(accepted.fields[0].disposition, "UNREADABLE");
    await access(path.join(dir, "COMPLETE.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reserves an output directory exclusively for the entire export", async () => {
  const { record, bytes } = await fixture();
  const dir = await mkdtemp(path.join(scratch, "export-test-"));
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  const first = exportAccepted({
    records: [record],
    outputDir: dir,
    readSource: async () => {
      started();
      await gate;
      return bytes;
    },
  });
  try {
    await begun;
    await assert.rejects(
      exportAccepted({
        records: [record],
        outputDir: dir,
        readSource: async () => bytes,
      }),
      /EXPORT_ALREADY_RUNNING/,
    );
  } finally {
    release();
    await first;
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifies retained originals even when all fields are unreadable", async () => {
  const { record } = await fixture();
  record.payload.fields = [
    { key: "name", disposition: "UNREADABLE", lines: [] },
  ];
  const dir = await mkdtemp(path.join(scratch, "export-test-"));
  try {
    await assert.rejects(
      exportAccepted({
        records: [record],
        outputDir: dir,
        readSource: async () => {
          throw new Error("SOURCE_UNAVAILABLE");
        },
      }),
    );
    await assert.rejects(access(path.join(dir, "COMPLETE.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preserves the reading direction of a rotated rectangle on a nonsquare page", async () => {
  const canvas = createCanvas(200, 100),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 200, 100);
  context.translate(100, 50);
  context.rotate(Math.PI / 6);
  context.fillStyle = "red";
  context.fillRect(-40, -5, 40, 10);
  context.fillStyle = "blue";
  context.fillRect(0, -5, 40, 10);
  const c = Math.sqrt(3) / 2,
    s = 0.5;
  const quad = [
    [-40, -5],
    [40, -5],
    [40, 5],
    [-40, 5],
  ].flatMap(([x, y]) => [
    (100 + x * c - y * s) / 200,
    (50 + x * s + y * c) / 100,
  ]);
  const page = await canonicalPage(canvas.toBuffer("image/png"), {
    mimeType: "image/png",
    pageNumber: 1,
  });
  const crop = await cropLine(page, quad);
  const { data, info } = await sharp(crop)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [80, 10]);
  const left = (5 * 80 + 10) * info.channels,
    right = (5 * 80 + 70) * info.channels;
  assert.ok(data[left] > 240 && data[left + 2] < 10);
  assert.ok(data[right + 2] > 240 && data[right] < 10);
});

test("PDF crop box and inherent rotation use the canonical upright page frame", async () => {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([100, 80]);
  page.setCropBox(10, 10, 60, 40);
  page.setRotation(degrees(90));
  page.drawRectangle({
    x: 10,
    y: 10,
    width: 60,
    height: 40,
    color: rgb(1, 0, 0),
  });
  const result = await canonicalPage(Buffer.from(await pdf.save()), {
    mimeType: "application/pdf",
    pageNumber: 1,
  });
  assert.equal(result.width, Math.ceil((40 * 200) / 72));
  assert.equal(result.height, Math.ceil((60 * 200) / 72));
  const { data } = await sharp(result.png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240 && data[1] < 10);
});

test("all EXIF orientations produce upright dimensions and pixels", async () => {
  const source = await sharp({
    create: { width: 60, height: 40, channels: 3, background: "white" },
  })
    .composite(
      await Promise.all(
        [
          ["red", 0, 0],
          ["lime", 30, 0],
          ["blue", 0, 20],
          ["yellow", 30, 20],
        ].map(async ([color, left, top]) => ({
          input: await sharp({
            create: { width: 30, height: 20, channels: 3, background: color },
          })
            .png()
            .toBuffer(),
          left,
          top,
        })),
      ),
    )
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const expected = [
    ["red", "green", "blue", "yellow"],
    ["green", "red", "yellow", "blue"],
    ["yellow", "blue", "green", "red"],
    ["blue", "yellow", "red", "green"],
    ["red", "blue", "green", "yellow"],
    ["blue", "red", "yellow", "green"],
    ["yellow", "green", "blue", "red"],
    ["green", "yellow", "red", "blue"],
  ];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = await sharp(source)
      .withMetadata({ orientation })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const result = await canonicalPage(bytes, {
      mimeType: "image/jpeg",
      pageNumber: 1,
    });
    assert.deepEqual(
      [result.width, result.height],
      orientation >= 5 ? [40, 60] : [60, 40],
    );
    const { data, info } = await sharp(result.png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const colors = [
      [5, 5],
      [result.width - 6, 5],
      [5, result.height - 6],
      [result.width - 6, result.height - 6],
    ].map(([x, y]) => {
      const start = (y * info.width + x) * info.channels,
        [r, g, b] = data.subarray(start, start + 3);
      if (r > 200 && g > 200 && b < 30) return "yellow";
      if (r > 200 && g < 30 && b < 30) return "red";
      if (g > 200 && r < 30 && b < 30) return "green";
      if (b > 200 && r < 30 && g < 30) return "blue";
      return "unknown";
    });
    assert.deepEqual(
      colors,
      expected[orientation - 1],
      `orientation ${orientation}`,
    );
  }
});

test("rejects crossed, out-of-bounds, nonrectangular and degenerate geometry", async () => {
  const { bytes } = await fixture(),
    page = await canonicalPage(bytes, { mimeType: "image/png", pageNumber: 1 });
  for (const quad of [
    [0, 0, 1, 1, 1, 0, 0, 1],
    [-0.1, 0, 0.5, 0, 0.5, 0.5, 0, 0.5],
    [0, 0, 0.8, 0, 0.7, 0.5, 0, 0.5],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ])
    await assert.rejects(cropLine(page, quad));
});

test("exports oriented segmentation regions and repeated stamps without inventing recognition text", async () => {
  const { bytes, record } = await fixture();
  record.payload.schema.sections = [
    { key: "main", label: "Основной документ", ordinal: 0, repeatable: false },
    { key: "stamps", label: "Штамп", ordinal: 1, repeatable: true },
    {
      key: "missing",
      label: "Незагруженная страница",
      ordinal: 2,
      repeatable: false,
    },
  ];
  record.payload.schema.fields[0].sectionKey = "main";
  record.payload.schema.fields[0].kind = "TEXT";
  record.payload.schema.fields.push(
    {
      key: "seal",
      label: "Печать",
      ordinal: 1,
      sectionKey: "stamps",
      kind: "STAMP",
      multiline: false,
    },
    {
      key: "missing_text",
      label: "Текст",
      ordinal: 2,
      sectionKey: "missing",
      kind: "TEXT",
      multiline: true,
    },
  );
  const region = (id, orientationDeg) => ({
    id,
    pageId: "page1",
    shape: "POLYGON",
    orientationDeg,
    polygon: [0.05, 0.05, 0.9, 0.05, 0.9, 0.9, 0.05, 0.9],
  });
  record.payload.sections = [
    {
      id: "main",
      sectionKey: "main",
      availability: "PRESENT",
      pageIds: ["page1"],
    },
    {
      id: "stamp1",
      sectionKey: "stamps",
      availability: "PRESENT",
      pageIds: ["page1"],
    },
    {
      id: "stamp2",
      sectionKey: "stamps",
      availability: "PRESENT",
      pageIds: ["page1"],
    },
    {
      id: "missing",
      sectionKey: "missing",
      availability: "NOT_UPLOADED",
      pageIds: [],
    },
  ];
  record.payload.fields[0].instanceId = "main";
  record.payload.fields[0].regions = [region("name-region", 0)];
  record.payload.fields.push(
    {
      key: "seal",
      instanceId: "stamp1",
      disposition: "PRESENT",
      lines: [],
      regions: [region("seal1", 180)],
    },
    {
      key: "seal",
      instanceId: "stamp2",
      disposition: "PRESENT",
      lines: [],
      regions: [region("seal2", 270)],
    },
  );
  const dir = await mkdtemp(path.join(scratch, "dataset-v2-"));
  try {
    const result = await exportAccepted({
      records: [record],
      outputDir: dir,
      readSource: async () => bytes,
    });
    assert.equal(result.lines, 2);
    const regions = (await readFile(path.join(dir, "regions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(regions.length, 3);
    assert.deepEqual(
      regions.map((r) => r.region.orientationDeg),
      [0, 180, 270],
    );
    assert.deepEqual(
      regions.slice(1).map((r) => r.field.instanceId),
      ["stamp1", "stamp2"],
    );
    assert.ok(regions.every((r) => r.source.pagePath.startsWith("pages/")));
    const snapshot = JSON.parse(
      (await readFile(path.join(dir, "snapshots.jsonl"), "utf8")).trim(),
    );
    assert.equal(snapshot.formatVersion, 2);
    assert.equal(snapshot.sections[3].availability, "NOT_UPLOADED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

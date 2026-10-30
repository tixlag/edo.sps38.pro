import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { PDFDocument } from "pdf-lib";
import { deflateRawSync } from "node:zlib";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ContractFileService,
  validateContractDocx,
} from "../src/contracts/contract-file.service";

const contentType =
  '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
function zip(entries: [string, string][]): Buffer {
  const files: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of entries) {
    const name = Buffer.from(path),
      original = Buffer.from(value),
      packed = deflateRawSync(original);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(original.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    files.push(local, name, packed);
    central.push(header, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
function docx(extra: [string, string][] = []) {
  return zip([
    ["[Content_Types].xml", contentType],
    ["word/document.xml", "<document><p>Contract</p></document>"],
    ...extra,
  ]);
}
async function pdf(pages = 1) {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i++) document.addPage();
  return Buffer.from(await document.save());
}
function service() {
  return new ContractFileService(new ConfigService());
}

afterEach(() => vi.restoreAllMocks());
describe("ContractFileService", () => {
  it("runs the converter with an isolated profile and cleans all private conversion files", async () => {
    const base = resolve(__dirname, "../../../.cache/contracts-test");
    await mkdir(base, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(base, "process-"));
    try {
      const binary = join(directory, "converter.mjs"),
        capture = join(directory, "capture.json");
      const output = await pdf();
      const executable = `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, cwd:process.cwd(), temp:process.env.TMPDIR }));
writeFileSync(join(args[args.indexOf("--outdir") + 1], "contract.pdf"), Buffer.from(${JSON.stringify(output.toString("base64"))}, "base64"));
`;
      await writeFile(binary, executable, { mode: 0o700 });
      const converter = new ContractFileService(
        new ConfigService({ CONTRACT_LIBREOFFICE_BIN: binary }),
      );
      const prepared = await converter.prepare(docx(), "source.docx");
      expect(prepared.pdf).toEqual(output);
      const invocation = JSON.parse(await readFile(capture, "utf8"));
      expect(invocation.args).toContain("pdf:writer_pdf_Export");
      expect(invocation.args[0]).toContain("-env:UserInstallation=file://");
      expect(invocation.cwd).toContain("/.cache/contracts/convert-");
      expect(invocation.temp).toBe(invocation.cwd);
      await expect(readdir(invocation.cwd)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("reports unavailable converter without losing or retaining private input files", async () => {
    const converter = new ContractFileService(
      new ConfigService({
        CONTRACT_LIBREOFFICE_BIN: "/nonexistent/contract-converter",
      }),
    );
    await expect(converter.prepare(docx(), "source.docx")).rejects.toThrow(
      "Конвертер DOCX недоступен",
    );
  });
  it("preserves valid PDF bytes without reserializing", async () => {
    const original = await pdf();
    const result = await service().prepare(original, "договор.PDF");
    expect(result.pdf).toBe(original);
    expect(result.original).toBeNull();
  });
  it("rejects false PDFs, malformed inputs, empty and oversized files", async () => {
    await expect(
      service().prepare(Buffer.from("a doc"), "contract.pdf"),
    ).rejects.toThrow("корректный PDF");
    await expect(
      service().prepare(
        Buffer.from("%PDF-1.7\nnot a document"),
        "contract.pdf",
      ),
    ).rejects.toThrow("корректный PDF");
    await expect(
      service().prepare(Buffer.alloc(0), "contract.pdf"),
    ).rejects.toThrow("Размер");
    await expect(
      service().prepare(Buffer.alloc(50 * 1024 * 1024 + 1), "contract.pdf"),
    ).rejects.toThrow("Размер");
    await expect(
      service().prepare(Buffer.from("unsupported"), "contract.doc"),
    ).rejects.toThrow("PDF или DOCX");
  });
  it("rejects PDF over the page limit", async () => {
    await expect(
      service().prepare(await pdf(101), "contract.pdf"),
    ).rejects.toThrow("100 страниц");
  });
  it("validates OOXML archive and preserves DOCX source together with converted PDF", async () => {
    const source = docx(),
      output = await pdf(),
      converter = service();
    vi.spyOn(
      converter as unknown as {
        convertDocx: (bytes: Buffer) => Promise<Buffer>;
      },
      "convertDocx",
    ).mockResolvedValue(output);
    const result = await converter.prepare(source, "договор.docx");
    expect(result).toEqual({
      pdf: output,
      original: source,
      originalFilename: "договор.docx",
    });
  });
  it("does not accept arbitrary ZIP renamed to DOCX", () => {
    expect(() =>
      validateContractDocx(zip([["text.txt", "not a word document"]])),
    ).toThrow("DOCX повреждён");
    expect(() => validateContractDocx(Buffer.from("not zip"))).toThrow(
      "DOCX повреждён",
    );
  });
  it("rejects archive path traversal, repeated entries, macros and remote resource links", () => {
    expect(() => validateContractDocx(docx([["../escape", "bad"]]))).toThrow();
    expect(() =>
      validateContractDocx(docx([["word/document.xml", "duplicate"]])),
    ).toThrow();
    expect(() =>
      validateContractDocx(docx([["word/vbaProject.bin", "macro"]])),
    ).toThrow();
    expect(() =>
      validateContractDocx(
        docx([
          [
            "word/_rels/document.xml.rels",
            '<Relationship TargetMode="External" Target="http://localhost/private"/>',
          ],
        ]),
      ),
    ).toThrow("внешние ссылки");
  });
  it("rejects zip bombs before launching converter", () => {
    expect(() =>
      validateContractDocx(
        docx([["word/large.xml", "x".repeat(2 * 1024 * 1024)]]),
      ),
    ).toThrow("DOCX повреждён");
  });
  it("rejects invalid converter output and releases the concurrency slot after failure", async () => {
    const converter = service();
    const mock = vi
      .spyOn(
        converter as unknown as {
          convertDocx: (bytes: Buffer) => Promise<Buffer>;
        },
        "convertDocx",
      )
      .mockResolvedValue(Buffer.from("bad"));
    await expect(converter.prepare(docx(), "contract.docx")).rejects.toThrow(
      "корректный PDF",
    );
    mock.mockResolvedValue(await pdf());
    await expect(
      converter.prepare(docx(), "contract.docx"),
    ).resolves.toHaveProperty("original");
  });
  it("bounds concurrent converters and recovers after completion", async () => {
    const converter = service();
    const result = await pdf();
    let release: (bytes: Buffer) => void = () => undefined;
    const pending = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    vi.spyOn(
      converter as unknown as {
        convertDocx: (bytes: Buffer) => Promise<Buffer>;
      },
      "convertDocx",
    ).mockReturnValue(pending);
    const first = converter.prepare(docx(), "first.docx"),
      second = converter.prepare(docx(), "second.docx");
    await expect(converter.prepare(docx(), "third.docx")).rejects.toThrow(
      "Конвертер занят",
    );
    release(result);
    await Promise.all([first, second]);
    await expect(
      converter.prepare(docx(), "fourth.docx"),
    ).resolves.toHaveProperty("pdf");
  });
});

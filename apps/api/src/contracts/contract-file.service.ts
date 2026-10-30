import { HttpException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PDFDocument } from "pdf-lib";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
export interface PreparedContractFile {
  pdf: Buffer;
  original: Buffer | null;
  originalFilename: string | null;
}

function invalidDocx(): never {
  throw new HttpException(
    "DOCX повреждён или содержит неподдерживаемое содержимое. Загрузите PDF.",
    400,
  );
}

/** Validate ZIP bounds before invoking the office parser; never extracts archive paths. */
export function validateContractDocx(bytes: Buffer): void {
  let eocd = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) invalidDocx();
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralStart = bytes.readUInt32LE(eocd + 16);
  if (
    !count ||
    count > 2000 ||
    bytes.readUInt16LE(eocd + 4) ||
    bytes.readUInt16LE(eocd + 6) ||
    bytes.readUInt16LE(eocd + 8) !== count ||
    centralStart + centralSize !== eocd
  )
    invalidDocx();
  let cursor = centralStart,
    expanded = 0;
  const names = new Set<string>();
  let contentTypes = "",
    documentFound = false;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50)
      invalidDocx();
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20),
      uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30),
      commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      end > eocd ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(cursor + 34)
    )
      invalidDocx();
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    const unixType = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    if (
      names.has(name) ||
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").includes("..") ||
      /vbaProject|activeX|embeddings\//i.test(name) ||
      unixType === 0xa000
    )
      invalidDocx();
    names.add(name);
    expanded += uncompressed;
    if (
      expanded > MAX_EXPANDED_BYTES ||
      uncompressed > MAX_BYTES ||
      (uncompressed > 1024 * 1024 && uncompressed > compressed * 1000)
    )
      invalidDocx();
    if (
      localOffset + 30 > centralStart ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    )
      invalidDocx();
    const localNameLength = bytes.readUInt16LE(localOffset + 26),
      localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataStart + compressed > centralStart ||
      bytes.readUInt16LE(localOffset + 6) !== flags ||
      bytes.readUInt16LE(localOffset + 8) !== method ||
      bytes
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .toString("utf8") !== name
    )
      invalidDocx();
    if (name === "word/document.xml") documentFound = uncompressed > 0;
    if (name === "[Content_Types].xml" || name.endsWith(".rels")) {
      if (uncompressed > 1024 * 1024) invalidDocx();
      let xml: string;
      try {
        const packed = bytes.subarray(dataStart, dataStart + compressed);
        const decoded =
          method === 0
            ? packed
            : inflateRawSync(packed, { maxOutputLength: 1024 * 1024 });
        if (decoded.length !== uncompressed) invalidDocx();
        xml = decoded.toString("utf8");
      } catch {
        invalidDocx();
      }
      if (/<!DOCTYPE|<!ENTITY/i.test(xml!)) invalidDocx();
      if (name === "[Content_Types].xml") contentTypes = xml!;
      // Offline conversion: external links/remote templates may otherwise fetch private resources.
      if (
        name.endsWith(".rels") &&
        /TargetMode\s*=\s*["']External["']/i.test(xml!)
      )
        throw new HttpException(
          "DOCX содержит внешние ссылки. Удалите их или загрузите готовый PDF.",
          400,
        );
    }
    cursor = end;
  }
  if (
    cursor !== eocd ||
    !documentFound ||
    !contentTypes.includes(DOCX_CONTENT_TYPE) ||
    /macroEnabled|vbaProject/i.test(contentTypes)
  )
    invalidDocx();
}

@Injectable()
export class ContractFileService {
  private conversions = 0;
  constructor(private readonly config: ConfigService) {}

  async prepare(
    bytes: Buffer,
    filename: string,
  ): Promise<PreparedContractFile> {
    if (!bytes.length || bytes.length > MAX_BYTES)
      throw new HttpException(
        "Размер договора должен быть от 1 байта до 50 МБ.",
        413,
      );
    if (/\.pdf$/i.test(filename)) {
      await this.validatePdf(bytes);
      return { pdf: bytes, original: null, originalFilename: null };
    }
    if (!/\.docx$/i.test(filename))
      throw new HttpException("Загрузите договор в формате PDF или DOCX.", 400);
    validateContractDocx(bytes);
    if (this.conversions >= 2)
      throw new HttpException(
        "Конвертер занят. Повторите загрузку через минуту.",
        503,
      );
    this.conversions++;
    try {
      const pdf = await this.convertDocx(bytes);
      await this.validatePdf(pdf);
      return {
        pdf,
        original: bytes,
        originalFilename: Array.from(filename)
          .map((char) =>
            char.charCodeAt(0) < 32 || char === "/" || char === "\\"
              ? "_"
              : char,
          )
          .join("")
          .slice(0, 255),
      };
    } finally {
      this.conversions--;
    }
  }

  private async validatePdf(bytes: Buffer): Promise<void> {
    try {
      if (
        !bytes.length ||
        bytes.length > MAX_BYTES ||
        !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))
      )
        throw new Error("Invalid PDF");
      const pdf = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
      if (pdf.getPageCount() < 1 || pdf.getPageCount() > 100)
        throw new Error("Page count");
    } catch {
      throw new HttpException(
        "Нужен корректный PDF без пароля, содержащий от 1 до 100 страниц и не более 50 МБ.",
        400,
      );
    }
  }

  private async convertDocx(bytes: Buffer): Promise<Buffer> {
    // src/ and dist/ have the same depth; cwd may be the repository root or apps/api.
    const cache = resolve(__dirname, "../../../../.cache/contracts");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(cache, "convert-"));
    try {
      const profile = join(directory, "profile"),
        profileUser = join(profile, "user");
      await mkdir(profileUser, { recursive: true, mode: 0o700 });
      await writeFile(
        join(profileUser, "registrymodifications.xcu"),
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>',
        { mode: 0o600 },
      );
      const input = join(directory, "contract.docx");
      await writeFile(input, bytes, { mode: 0o600 });
      const binary =
        this.config.get<string>("CONTRACT_LIBREOFFICE_BIN") || "libreoffice";
      await new Promise<void>((accept, reject) => {
        const child = spawn(
          binary,
          [
            `-env:UserInstallation=${pathToFileURL(profile).href}`,
            "--headless",
            "--nologo",
            "--nodefault",
            "--norestore",
            "--convert-to",
            "pdf:writer_pdf_Export",
            "--outdir",
            directory,
            input,
          ],
          {
            cwd: directory,
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              TMPDIR: directory,
              TMP: directory,
              TEMP: directory,
              SAL_USE_VCLPLUGIN: "svp",
            },
          },
        );
        const terminate = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        const timer = setTimeout(() => {
          terminate();
          reject(
            new HttpException(
              "Конвертация DOCX заняла слишком много времени. Загрузите готовый PDF.",
              504,
            ),
          );
        }, 60_000);
        child.once("error", () => {
          clearTimeout(timer);
          reject(
            new HttpException(
              "Конвертер DOCX недоступен. Загрузите PDF или обратитесь к администратору.",
              503,
            ),
          );
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          terminate();
          if (code === 0) accept();
          else
            reject(
              new HttpException(
                "Не удалось преобразовать DOCX. Загрузите готовый PDF.",
                422,
              ),
            );
        });
      });
      const output = join(directory, "contract.pdf");
      const info = await stat(output).catch(() => null);
      if (!info?.isFile() || !info.size || info.size > MAX_BYTES)
        throw new HttpException(
          "Конвертер не создал допустимый PDF. Загрузите готовый PDF.",
          422,
        );
      return await readFile(output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

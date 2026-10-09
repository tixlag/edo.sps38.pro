import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const UPLOAD_CACHE = join(
  __dirname,
  "../../../../.cache/document-uploads",
);
export interface StagedFile {
  id: string;
  path: string;
  ordinal: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
}
export interface StagedUpload {
  directory: string;
  documentTypeCode: string;
  locationId?: number;
  files: StagedFile[];
}

@Injectable()
export class DocumentUploadService {
  async parse(req: FastifyRequest): Promise<StagedUpload> {
    if (!req.isMultipart())
      throw new UnsupportedMediaTypeException("Expected multipart/form-data");
    await mkdir(UPLOAD_CACHE, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(UPLOAD_CACHE, "upload-"));
    const fields = new Map<string, string>();
    const files: StagedFile[] = [];
    let total = 0;
    try {
      for await (const part of req.parts({
        limits: {
          files: 10,
          fields: 2,
          parts: 12,
          fileSize: MAX_FILE_BYTES,
          fieldSize: 128,
        },
      })) {
        if (part.type === "field") {
          if (
            !["documentTypeCode", "locationId"].includes(part.fieldname) ||
            fields.has(part.fieldname) ||
            typeof part.value !== "string" ||
            part.valueTruncated
          ) {
            throw new BadRequestException(
              "Invalid or repeated multipart field",
            );
          }
          fields.set(part.fieldname, part.value);
          continue;
        }
        if (part.fieldname !== "files[]" && part.fieldname !== "files") {
          part.file.resume();
          throw new BadRequestException("Files must use files[]");
        }
        const id = randomUUID();
        const path = join(directory, id);
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sizeBytes += chunk.length;
            total += chunk.length;
            if (sizeBytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES)
              return callback(
                new PayloadTooLargeException("Upload size limit exceeded"),
              );
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          part.file,
          counter,
          createWriteStream(path, { mode: 0o600 }),
        );
        if (part.file.truncated)
          throw new PayloadTooLargeException("File exceeds 10 MiB");
        const { mimeType, pageCount } = await this.inspect(
          await readFile(path),
        );
        files.push({
          id,
          path,
          ordinal: files.length,
          filename: basename(part.filename || "document").slice(0, 255),
          mimeType,
          sizeBytes,
          sha256: hash.digest("hex"),
          pageCount,
        });
      }
      const documentTypeCode = fields.get("documentTypeCode");
      if (
        !documentTypeCode ||
        documentTypeCode.length > 64 ||
        files.length === 0
      )
        throw new BadRequestException(
          "documentTypeCode and at least one file are required",
        );
      const loc = fields.get("locationId");
      if (
        loc !== undefined &&
        (!/^\d+$/.test(loc) ||
          !Number.isSafeInteger(Number(loc)) ||
          Number(loc) <= 0 ||
          Number(loc) > 2147483647)
      ) {
        throw new BadRequestException("locationId must be a positive integer");
      }
      if (files.reduce((n, f) => n + f.pageCount, 0) > 100)
        throw new PayloadTooLargeException("At most 100 pages per document");
      return {
        directory,
        documentTypeCode,
        ...(loc !== undefined ? { locationId: Number(loc) } : {}),
        files,
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (
        String((error as { code?: string }).code ?? "").startsWith("FST_") &&
        /LIMIT|TOO_LARGE/.test(String((error as { code?: string }).code))
      ) {
        throw new PayloadTooLargeException("Multipart limit exceeded");
      }
      throw error;
    }
  }

  async inspect(
    bytes: Buffer,
  ): Promise<{ mimeType: string; pageCount: number }> {
    if (bytes.length === 0) throw new BadRequestException("Empty file");
    if (bytes.subarray(0, 5).toString() === "%PDF-") {
      try {
        const pdf = await PDFDocument.load(bytes, {
          ignoreEncryption: false,
          throwOnInvalidObject: true,
          updateMetadata: false,
        });
        const pageCount = pdf.getPageCount();
        if (pageCount < 1) throw new Error("Empty PDF");
        return { mimeType: "application/pdf", pageCount };
      } catch {
        throw new BadRequestException("PDF is damaged or password-protected");
      }
    }
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp =
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP";
    if (!jpeg && !png && !webp)
      throw new UnsupportedMediaTypeException(
        "Only JPEG, PNG, WebP and PDF are supported",
      );
    try {
      const image = sharp(bytes, {
        failOn: "warning",
        limitInputPixels: 40_000_000,
      });
      const metadata = await image.metadata();
      if ((metadata.pages ?? 1) !== 1)
        throw new Error("Animated images are not supported");
      await image.timeout({ seconds: 10 }).stats(); // Decode pixels; metadata alone accepts truncated images.
      return {
        mimeType: jpeg ? "image/jpeg" : png ? "image/png" : "image/webp",
        pageCount: 1,
      };
    } catch {
      throw new BadRequestException(
        "Image is damaged, animated or exceeds 40 megapixels",
      );
    }
  }

  async dispose(upload: StagedUpload): Promise<void> {
    await rm(upload.directory, { recursive: true, force: true });
  }

  async cleanupCache(): Promise<void> {
    await mkdir(UPLOAD_CACHE, { recursive: true, mode: 0o700 });
    for (const name of await readdir(UPLOAD_CACHE)) {
      if (!name.startsWith("upload-")) continue;
      const path = join(UPLOAD_CACHE, name);
      const entry = await stat(path).catch(() => null);
      if (entry && Date.now() - entry.mtimeMs > 3600_000)
        await rm(path, { recursive: true, force: true });
    }
  }
}

import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** MIME/extension supplied by a browser are not trusted. */
export function isHeic(bytes: Buffer): boolean {
  if (bytes.length < 24 || bytes.toString("ascii", 4, 8) !== "ftyp")
    return false;
  const length = bytes.readUInt32BE(0);
  if (length < 16 || length > bytes.length || length > 4096 || length % 4 !== 0)
    return false;
  const major = bytes.toString("ascii", 8, 12);
  return ["heic", "heix", "heim", "heis", "mif1"].includes(major);
}
export interface HeicNormalizationResult {
  algorithm: string;
  mode: string;
  width: number;
  height: number;
  sizeBytes: number;
  ssim: number;
  psnr: number | null;
  edgeMse: number;
}
let active = false;
/** One expensive HEIC conversion per API process; excess requests retry with the same upload key. */
export async function normalizeHeic(
  input: string,
  output: string,
): Promise<HeicNormalizationResult> {
  if (active) throw new HttpException("HEIC_CONVERSION_BUSY", 429);
  active = true;
  let worker: ChildProcess | undefined;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = fork(
      join(__dirname, "heic-normalization.worker.cjs"),
      [input, output],
      {
        execArgv: ["--max-old-space-size=64"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    return await new Promise<HeicNormalizationResult>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new BadRequestException("HEIC_CONVERSION_TIMEOUT")),
        60000,
      );
      worker!.on("error", () =>
        reject(new BadRequestException("HEIC_CONVERSION_FAILED")),
      );
      worker!.on("exit", () =>
        reject(new BadRequestException("HEIC_CONVERSION_FAILED")),
      );
      worker!.on(
        "message",
        (message: {
          decode?: boolean;
          error?: string;
          result?: HeicNormalizationResult;
        }) => {
          if (message.decode) {
            child = execFile(
              "heif-convert",
              [
                "--quiet",
                "--png-compression-level",
                "0",
                input,
                `${input}.decoded.png`,
              ],
              { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 16384 },
              (error) => {
                child = undefined;
                if (worker?.connected)
                  worker.send(
                    error
                      ? {
                          error:
                            error.code === "ENOENT"
                              ? "HEIC_DECODER_UNAVAILABLE"
                              : "HEIC_DECODE_FAILED",
                        }
                      : { decoded: true },
                    () => undefined,
                  );
              },
            );
          }
          if (message.result) resolve(message.result);
          if (message.error === "HEIC_DECODER_UNAVAILABLE")
            reject(new ServiceUnavailableException(message.error));
          else if (
            ["HEIC_PIXELS_LIMIT", "HEIC_OUTPUT_LIMIT"].includes(
              message.error ?? "",
            )
          )
            reject(new PayloadTooLargeException(message.error));
          else if (message.error)
            reject(new BadRequestException(message.error));
        },
      );
    });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) =>
        child!.once("close", () => resolve()),
      );
      child.kill("SIGKILL");
      await stopped;
    }
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const stopped = new Promise<void>((resolve) =>
        worker!.once("exit", () => resolve()),
      );
      worker.kill("SIGKILL");
      await stopped;
    }
    active = false;
  }
}

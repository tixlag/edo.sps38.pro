import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { candidateSnapshotSchema } from "./document-contract";
import type { CandidateSnapshotDto } from "./dto/document.dto";

export class ErpCandidateError extends Error {
  constructor(
    readonly status: number,
    readonly transient: boolean,
  ) {
    super(
      status === 404 ? "ERP_CANDIDATE_NOT_FOUND" : "ERP_CANDIDATE_UNAVAILABLE",
    );
  }
}
const identitySchema = z.object({
  uuid: z.string().uuid(),
  position: z.object({ code: z.string().min(1).max(64).regex(/^\S+$/) }),
  citizenship: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .default("ru"),
});
const text = (value: unknown, max: number) =>
  typeof value === "string"
    ? value.trim().slice(0, max).trim() || undefined
    : undefined;
function namedCode(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const code = text(raw.code, 64),
    name = text(raw.name, 256);
  return code || name
    ? { ...(code ? { code } : {}), ...(name ? { name } : {}) }
    : undefined;
}
export function normalizeErpCandidate(
  raw: unknown,
  chatUuid: string,
): CandidateSnapshotDto {
  const identity = identitySchema.safeParse(raw);
  if (
    !identity.success ||
    identity.data.uuid.toLowerCase() !== chatUuid.toLowerCase()
  )
    throw new ErpCandidateError(503, false);
  const row = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {
    uuid: chatUuid.toLowerCase(),
    citizenship: identity.data.citizenship.toLowerCase(),
  };
  for (const [key, max] of [
    ["name", 256],
    ["birthDate", 32],
    ["code1C", 64],
    ["manager", 256],
    ["managerCode1C", 64],
  ] as const) {
    const value = text(row[key], max);
    if (value) result[key] = value;
  }
  if (typeof row.isReemployment === "boolean")
    result.isReemployment = row.isReemployment;
  for (const key of ["position", "project"]) {
    const value = namedCode(row[key]);
    if (value) result[key] = value;
  }
  if (row.mentor && typeof row.mentor === "object") {
    const rawMentor = row.mentor as Record<string, unknown>;
    const mentor = Object.fromEntries(
      ["name", "position", "code1C"].flatMap((key) => {
        const value = text(rawMentor[key], key === "code1C" ? 64 : 256);
        return value ? [[key, value]] : [];
      }),
    );
    if (Object.keys(mentor).length) result.mentor = mentor;
  }
  if (!candidateSnapshotSchema.safeParse(result).success)
    throw new ErpCandidateError(503, false);
  return result as unknown as CandidateSnapshotDto;
}

@Injectable()
export class ErpCandidateClient {
  constructor(private readonly config: ConfigService) {}

  async findByChatUuid(
    chatUuid: string,
    signal?: AbortSignal,
  ): Promise<CandidateSnapshotDto> {
    signal?.throwIfAborted();
    const endpoint = this.config.get<string>("ERP_CANDIDATE_URL");
    const token = this.config.get<string>("ERP_CANDIDATE_TOKEN");
    const username = this.config.get<string>("ERP_USERNAME"),
      password = this.config.get<string>("ERP_PASSWORD");
    if (!endpoint || !token || !username || !password)
      throw new ErpCandidateError(503, false);
    let url: URL;
    try {
      url = new URL(endpoint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ErpCandidateError(503, false);
    }
    url.searchParams.set("uuid", chatUuid);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          token,
          Accept: "application/json",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok)
        throw new ErpCandidateError(
          response.status,
          [408, 425, 429, 500, 502, 503, 504].includes(response.status),
        );
      const body = await response.text();
      if (Buffer.byteLength(body) > 128 * 1024)
        throw new ErpCandidateError(503, false);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new ErpCandidateError(503, false);
      }
      return normalizeErpCandidate(raw, chatUuid);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ErpCandidateError) throw error;
      throw new ErpCandidateError(503, true);
    }
  }
}

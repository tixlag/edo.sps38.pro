import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { candidateSnapshotSchema } from "./document-contract";
import {
  CandidateDocumentErrorCode as Code,
  CandidateProfileField as Field,
} from "./dto/candidate-error.dto";
import type { CandidateSnapshotDto } from "./dto/document.dto";

export class ErpCandidateError extends Error {
  constructor(
    readonly status: number,
    readonly transient: boolean,
    readonly code: Code = status === 404
      ? Code.ERP_CANDIDATE_NOT_FOUND
      : status === 401 || status === 403
        ? Code.DOCUMENTS_INTEGRATION_MISCONFIGURED
        : transient
          ? [408, 504].includes(status)
            ? Code.ERP_TIMEOUT
            : Code.ERP_UNAVAILABLE
          : Code.ERP_CONTRACT_ERROR,
    readonly fields?: Field[],
  ) {
    super(code);
  }
}
const uuidSchema = z.string().uuid();
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
  chatUuid?: string,
  code1c?: string,
): CandidateSnapshotDto {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ErpCandidateError(502, false);
  const envelope = raw as Record<string, unknown>;
  let row = envelope;
  if (Object.prototype.hasOwnProperty.call(envelope, "candidate")) {
    const candidate = envelope.candidate;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new ErpCandidateError(502, false);
    // Production nests personal fields under candidate; reference data is
    // top-level. Flat normalized snapshots remain valid when read from cache.
    row = {
      ...candidate,
      position: envelope.position,
      project: envelope.project,
      manager: envelope.manager,
      mentor: envelope.mentor,
    };
  }
  // 1C calls the chat identifier `uuid`; keep that wire name unchanged.
  const returnedUuid =
    row.uuid == null || (typeof row.uuid === "string" && !row.uuid.trim())
      ? null
      : row.uuid;
  if (
    (returnedUuid !== null && !uuidSchema.safeParse(returnedUuid).success) ||
    (chatUuid &&
      (typeof returnedUuid !== "string" ||
        returnedUuid.toLowerCase() !== chatUuid.toLowerCase())) ||
    (code1c && row.code1C !== code1c)
  )
    throw new ErpCandidateError(502, false);
  const position = row.position as Record<string, unknown> | null | undefined;
  const fields: Field[] = [];
  if (
    !position ||
    position.code == null ||
    (typeof position.code === "string" && !position.code.trim())
  )
    fields.push(Field.POSITION_CODE);
  const citizenship =
    row.citizenship == null ||
    (typeof row.citizenship === "string" && !row.citizenship.trim())
      ? "ru"
      : row.citizenship;
  if (fields.length)
    throw new ErpCandidateError(
      422,
      false,
      Code.CANDIDATE_PROFILE_INCOMPLETE,
      fields,
    );
  if (
    typeof position?.code !== "string" ||
    !/^\S{1,64}$/.test(position.code) ||
    typeof citizenship !== "string" ||
    !/^[a-zA-Z]{2}$/.test(citizenship)
  )
    throw new ErpCandidateError(502, false);
  const result: Record<string, unknown> = {
    uuid: typeof returnedUuid === "string" ? returnedUuid.toLowerCase() : null,
    citizenship: citizenship.toLowerCase(),
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
  const manager = namedCode(row.manager);
  if (manager?.name) result.manager = manager.name;
  if (manager?.code) result.managerCode1C = manager.code;
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
    throw new ErpCandidateError(502, false);
  return result as unknown as CandidateSnapshotDto;
}

@Injectable()
export class ErpCandidateClient {
  constructor(private readonly config: ConfigService) {}

  async findByChatUuid(
    chatUuid: string,
    signal?: AbortSignal,
  ): Promise<CandidateSnapshotDto> {
    return this.request({ uuid: chatUuid }, signal);
  }

  async findByEmployeeCode(
    code1c: string,
    signal?: AbortSignal,
  ): Promise<CandidateSnapshotDto> {
    if (!/^\S{1,64}$/.test(code1c)) throw new ErpCandidateError(502, false);
    return this.request({ code1c }, signal);
  }

  private async request(
    lookup: { uuid: string } | { code1c: string },
    signal?: AbortSignal,
  ): Promise<CandidateSnapshotDto> {
    signal?.throwIfAborted();
    const endpoint = this.config.get<string>("ERP_CANDIDATE_URL");
    const token = this.config.get<string>("ERP_CANDIDATE_TOKEN");
    const username = this.config.get<string>("ERP_USERNAME"),
      password = this.config.get<string>("ERP_PASSWORD");
    if (!endpoint || !token || !username || !password)
      throw new ErpCandidateError(
        503,
        false,
        Code.DOCUMENTS_INTEGRATION_MISCONFIGURED,
      );
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
      throw new ErpCandidateError(
        503,
        false,
        Code.DOCUMENTS_INTEGRATION_MISCONFIGURED,
      );
    }
    url.searchParams.delete("uuid");
    url.searchParams.delete("code_1c");
    url.searchParams.delete("code1c");
    for (const [key, value] of Object.entries(lookup))
      url.searchParams.set(key, value);
    let response: Response;
    const timeout = AbortSignal.timeout(15_000);
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          token,
          Accept: "application/json",
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error",
      });
      if (!response.ok)
        throw new ErpCandidateError(
          response.status,
          [408, 425, 429, 500, 502, 503, 504].includes(response.status),
        );
      const body = await response.text();
      if (Buffer.byteLength(body) > 128 * 1024)
        throw new ErpCandidateError(502, false);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new ErpCandidateError(502, false);
      }
      return "uuid" in lookup
        ? normalizeErpCandidate(raw, lookup.uuid)
        : normalizeErpCandidate(raw, undefined, lookup.code1c);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ErpCandidateError) throw error;
      throw new ErpCandidateError(
        timeout.aborted ? 504 : 503,
        true,
        timeout.aborted ? Code.ERP_TIMEOUT : Code.ERP_UNAVAILABLE,
      );
    }
  }
}

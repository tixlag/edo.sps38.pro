import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  isEmployeeCode,
  LkAuthError,
  LkContractError,
  LkEdoClient,
  LkNotFoundError,
  LkTimeoutError,
} from "@edo/lk-client";
import { CandidateDocumentError } from "./candidate-document.error";
import { CandidateDocumentErrorCode as Code } from "./dto/candidate-error.dto";

@Injectable()
export class LkCandidateIdentityService {
  private readonly client: LkEdoClient;
  private readonly configured: boolean;
  constructor(config: ConfigService) {
    const baseUrl = config.get<string>("LK_BASE_URL") ?? "";
    const internalToken = config.get<string>("LK_EDO_INTERNAL_TOKEN") ?? "";
    let validUrl = false;
    try {
      const url = new URL(baseUrl);
      validUrl =
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash;
    } catch {
      /* Fail closed on invalid configuration. */
    }
    this.configured = !!internalToken && validUrl;
    this.client = new LkEdoClient({
      baseUrl,
      internalToken,
      maxRetries: 0,
      requestTimeoutMs: 5000,
    });
  }
  async byUuid(chatUuid: string, signal?: AbortSignal) {
    return this.lookup(
      () => this.client.getCandidateChat(chatUuid, { signal }),
      false,
      signal,
    );
  }
  async byEmployee(code1c: string, signal?: AbortSignal) {
    if (!isEmployeeCode(code1c))
      throw new CandidateDocumentError(Code.EMPLOYEE_IDENTITY_INVALID);
    return this.lookup(
      () => this.client.getEmployeeCandidateChat(code1c, { signal }),
      true,
      signal,
    );
  }
  private async lookup<T>(
    request: () => Promise<T>,
    own: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.configured)
      throw new CandidateDocumentError(
        Code.DOCUMENTS_INTEGRATION_MISCONFIGURED,
      );
    const started = Date.now();
    try {
      return await request();
    } catch (error) {
      const failure = (code: Code) =>
        new CandidateDocumentError(code, undefined, {
          source: "LK",
          upstreamStatus: (error as { status?: number }).status,
          durationMs: Date.now() - started,
        });
      if (signal?.aborted) throw failure(Code.DOCUMENTS_TIMEOUT);
      if (error instanceof LkNotFoundError)
        throw failure(
          own ? Code.CANDIDATE_LINK_MISSING : Code.CANDIDATE_CHAT_NOT_FOUND,
        );
      if (error instanceof LkAuthError)
        throw failure(Code.DOCUMENTS_INTEGRATION_MISCONFIGURED);
      if (error instanceof LkContractError)
        throw failure(Code.LK_CONTRACT_ERROR);
      if (
        error instanceof LkTimeoutError ||
        [408, 504].includes((error as { status?: number }).status ?? 0)
      )
        throw failure(Code.LK_TIMEOUT);
      throw failure(Code.LK_UNAVAILABLE);
    }
  }
}

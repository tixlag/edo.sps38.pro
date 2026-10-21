import { Injectable } from "@nestjs/common";
import {
  CandidateDocumentError,
  withinDocumentDeadline,
} from "./candidate-document.error";
import type { EdoCandidateChat } from "@edo/lk-client";
import { CandidateDocumentErrorCode as Code } from "./dto/candidate-error.dto";
import { CandidateContextService } from "./candidate-context.service";
import { LkCandidateIdentityService } from "./lk-candidate-identity.service";
import { DocumentCatalogService } from "./document-catalog.service";
import { DocumentReadService } from "./document-read.service";
import { DocumentEventsService } from "./document-events.service";
import { DocumentUploadGrantService } from "./document-upload-grant.service";
import type {
  CandidateDocumentContextDto,
  CandidateDocumentUploadRequestDto,
} from "./dto/candidate-context.dto";

type OwnIdentity = { code1c: string; chat: EdoCandidateChat | null };

@Injectable()
export class CandidateDocumentsService {
  constructor(
    private readonly contexts: CandidateContextService,
    private readonly identity: LkCandidateIdentityService,
    private readonly catalog: DocumentCatalogService,
    private readonly reads: DocumentReadService,
    private readonly events: DocumentEventsService,
    private readonly grants: DocumentUploadGrantService,
  ) {}
  context(uuid: string) {
    return this.contexts.context(uuid);
  }
  private async ownIdentity(code1c: string | null, signal?: AbortSignal) {
    if (!code1c)
      throw new CandidateDocumentError(Code.EMPLOYEE_IDENTITY_REQUIRED);
    try {
      const chat = await this.identity.byEmployee(code1c, signal);
      if (chat.code1c !== code1c)
        throw new CandidateDocumentError(Code.LK_CONTRACT_ERROR);
      return { code1c, chat };
    } catch (error) {
      if (
        error instanceof CandidateDocumentError &&
        error.code === Code.CANDIDATE_LINK_MISSING
      )
        return { code1c, chat: null };
      throw error;
    }
  }
  private ownContextFor(identity: OwnIdentity, signal?: AbortSignal) {
    return identity.chat
      ? this.contexts.forIdentity(identity.chat, signal)
      : this.contexts.forEmployee(identity.code1c);
  }
  private ownScope(identity: OwnIdentity) {
    return identity.chat
      ? { chat_uuid: identity.chat.chatUuid }
      : { code_1c: identity.code1c };
  }
  private ownOperation<T>(
    code1c: string | null,
    work: (identity: OwnIdentity, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(22_000);
    return withinDocumentDeadline(
      (async () => work(await this.ownIdentity(code1c, signal), signal))(),
      signal,
    );
  }
  ownContext(code1c: string | null) {
    return this.ownOperation(code1c, (identity, signal) =>
      this.ownContextFor(identity, signal),
    );
  }
  ownForms(code1c: string | null) {
    return this.ownOperation(code1c, async (identity, signal) => {
      const context = await this.ownContextFor(identity, signal);
      const catalog = await this.catalog.list(
        context.positionCode1c,
        context.citizenship,
      );
      return { context, catalog };
    });
  }
  ownStatuses(code1c: string | null) {
    return this.ownOperation(code1c, (identity) =>
      this.reads.internalDocuments(this.ownScope(identity)),
    );
  }
  ownDraft(code1c: string | null, documentUid: string) {
    return this.ownOperation(code1c, (identity) =>
      this.reads.internalDraft(this.ownScope(identity), documentUid),
    );
  }
  ownStreamGrant(code1c: string | null) {
    return this.ownOperation(code1c, (identity) =>
      this.events.grant(this.ownScope(identity)),
    );
  }
  ownUploadGrant(
    code1c: string | null,
    data: CandidateDocumentUploadRequestDto,
  ) {
    return this.ownOperation(code1c, async (identity, signal) =>
      this.grant(await this.ownContextFor(identity, signal), data),
    );
  }
  async types(uuid: string) {
    const context = await this.contexts.context(uuid);
    return this.catalog.list(context.positionCode1c, context.citizenship);
  }
  async statuses(uuid: string) {
    const chat = await this.identity.byUuid(uuid);
    return this.reads.internalDocuments({ chat_uuid: chat.chatUuid });
  }
  async draft(uuid: string, documentUid: string) {
    const chat = await this.identity.byUuid(uuid);
    return this.reads.internalDraft({ chat_uuid: chat.chatUuid }, documentUid);
  }
  async streamGrant(uuid: string) {
    const chat = await this.identity.byUuid(uuid);
    return this.events.grant({ chat_uuid: chat.chatUuid });
  }
  async uploadGrant(uuid: string, data: CandidateDocumentUploadRequestDto) {
    const context = await this.contexts.context(uuid);
    return this.grant(context, data);
  }
  private grant(
    context: CandidateDocumentContextDto,
    data: CandidateDocumentUploadRequestDto,
  ) {
    return this.grants.grant({
      documentUid: data.documentUid,
      idempotencyKey: data.idempotencyKey,
      ...(context.chatUuid ? { chat_uuid: context.chatUuid } : {}),
      ...(context.code1c ? { code_1c: context.code1c } : {}),
      position_code_1c: context.positionCode1c,
      citizenship: context.citizenship,
      ...(context.projectCode1c
        ? { project_code_1c: context.projectCode1c }
        : {}),
      candidateSnapshot: context.candidateSnapshot,
    });
  }
}

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
import type { CandidateDocumentUploadRequestDto } from "./dto/candidate-context.dto";

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
    const chat = await this.identity.byEmployee(code1c, signal);
    if (chat.code1c !== code1c)
      throw new CandidateDocumentError(Code.LK_CONTRACT_ERROR);
    return chat;
  }
  private ownOperation<T>(
    code1c: string | null,
    work: (chat: EdoCandidateChat, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(22_000);
    return withinDocumentDeadline(
      (async () => work(await this.ownIdentity(code1c, signal), signal))(),
      signal,
    );
  }
  ownContext(code1c: string | null) {
    return this.ownOperation(code1c, (chat, signal) =>
      this.contexts.forIdentity(chat, signal),
    );
  }
  ownForms(code1c: string | null) {
    return this.ownOperation(code1c, async (chat, signal) => {
      const context = await this.contexts.forIdentity(chat, signal);
      const catalog = await this.catalog.list(
        context.positionCode1c,
        context.citizenship,
      );
      return { context, catalog };
    });
  }
  ownStatuses(code1c: string | null) {
    return this.ownOperation(code1c, (chat) =>
      this.reads.internalDocuments({ chat_uuid: chat.chatUuid }),
    );
  }
  ownDraft(code1c: string | null, documentUid: string) {
    return this.ownOperation(code1c, (chat) =>
      this.reads.internalDraft({ chat_uuid: chat.chatUuid }, documentUid),
    );
  }
  ownStreamGrant(code1c: string | null) {
    return this.ownOperation(code1c, (chat) =>
      this.events.grant({ chat_uuid: chat.chatUuid }),
    );
  }
  ownUploadGrant(
    code1c: string | null,
    data: CandidateDocumentUploadRequestDto,
  ) {
    return this.ownOperation(code1c, async (chat, signal) =>
      this.grant(await this.contexts.forIdentity(chat, signal), data),
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
    context: Awaited<ReturnType<CandidateContextService["context"]>>,
    data: CandidateDocumentUploadRequestDto,
  ) {
    return this.grants.grant({
      documentUid: data.documentUid,
      idempotencyKey: data.idempotencyKey,
      chat_uuid: context.chatUuid,
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

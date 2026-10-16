import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
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
  async ownContext(code1c: string | null) {
    if (!code1c) throw new UnauthorizedException("Employee identity required");
    const context = await this.contexts.context(
      await this.contexts.ownChat(code1c),
    );
    if (context.code1c !== code1c)
      throw new ForbiddenException("Candidate employee association changed");
    return context;
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

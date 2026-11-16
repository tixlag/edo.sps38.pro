import { Injectable, Logger, NotFoundException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ErpCommunicationsClient, CommunicationSourceError } from "../communications/erp-communications.client";
import { LkChatClient } from "../communications/lk-chat.client";
import { DocumentAccessService } from "./document-access.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { ChatChannel } from "../communications/communications.dto";
import { SendStatus, type CommunicationOperationDto } from "../communications/communications.dto";

/** Uses the existing communication operation ledger and candidate channels. */
@Injectable()
export class DocumentReturnNotificationService {
  private readonly logger = new Logger(DocumentReturnNotificationService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpCommunicationsClient,
    private readonly lk: LkChatClient,
    private readonly access: DocumentAccessService,
  ) {}

  async send(operationId: string): Promise<void> {
    const operation = await this.prisma.communicationOperation.findUnique({
      where: { id: operationId }, include: { candidate: true },
    });
    if (!operation || operation.status !== "PENDING") return;
    // Reserve this exact dispatch before touching a provider. If the process
    // stops after the provider accepted it, UNKNOWN prevents an unsafe replay.
    const claimed = await this.prisma.communicationOperation.updateMany({
      where: { id: operationId, status: "PENDING" },
      data: { status: "UNKNOWN", errorCode: "SEND_RESULT_UNKNOWN" },
    });
    if (claimed.count !== 1) return;
    const candidate = operation.candidate;
    let status: "SENT" | "FAILED" | "UNKNOWN" = "FAILED";
    let providerId: string | null = null;
    let errorCode: string | null = null;
    let channel = operation.channel;
    let recipientId = operation.recipientId;
    try {
      if (candidate.chatUuid && this.lk.configured() && operation.actorCode1c) {
        channel = ChatChannel.LK;
        recipientId = candidate.chatUuid;
        providerId = await this.lk.sendText(candidate.chatUuid, operation.actorCode1c,
          operation.text, operation.id);
        status = "SENT";
      } else if (candidate.erpUid && operation.actorCode1c && this.erp.configured()) {
        const context = await this.erp.context(candidate.erpUid, operation.actorCode1c);
        const recipient = context.recipients.find((r) => r.channel !== ChatChannel.LK);
        if (!recipient) throw new CommunicationSourceError("CANDIDATE_CHANNEL_UNAVAILABLE");
        channel = recipient.channel;
        recipientId = recipient.id;
        const result = await this.erp.send({ candidate: candidate.erpUid,
          actor: operation.actorCode1c, requestId: operation.id,
          channel, recipientId, text: operation.text });
        status = result.status;
        providerId = result.providerId ?? null;
        errorCode = result.errorCode ?? null;
      } else throw new CommunicationSourceError("CANDIDATE_CHANNEL_UNAVAILABLE");
    } catch (error) {
      status = error instanceof CommunicationSourceError && error.uncertain ? "UNKNOWN" : "FAILED";
      errorCode = error instanceof CommunicationSourceError ? error.code : "CANDIDATE_NOTIFICATION_FAILED";
      this.logger.warn(`Candidate return notification ${operationId}: ${errorCode}`);
    }
    await this.prisma.communicationOperation.updateMany({
      where: { id: operationId, status: "UNKNOWN" },
      data: { status, providerId, errorCode, channel, recipientId },
    });
  }

  async retry(documentId: string, operationId: string, principal: AuthPrincipal) {
    const document = await this.access.document(documentId, principal);
    if (!document.candidateId) throw new NotFoundException("RETURN_NOTIFICATION_NOT_FOUND");
    const operation = await this.prisma.communicationOperation.findFirst({
      where: { id: operationId, candidateId: document.candidateId, requestKey: { startsWith: `document-return:${documentId}:` } },
    });
    if (!operation) throw new NotFoundException("RETURN_NOTIFICATION_NOT_FOUND");
    if (operation.status !== "FAILED") throw new ConflictException("RETURN_NOTIFICATION_NOT_RETRYABLE");
    await this.prisma.communicationOperation.updateMany({
      where: { id: operationId, status: "FAILED" },
      data: { status: "PENDING", errorCode: null },
    });
    await this.send(operationId);
    const result = await this.prisma.communicationOperation.findUniqueOrThrow({ where: { id: operationId } });
    return this.dto(result);
  }

  async list(documentId: string, principal: AuthPrincipal): Promise<CommunicationOperationDto[]> {
    const document = await this.access.document(documentId, principal);
    if (!document.candidateId) return [];
    const operations = await this.prisma.communicationOperation.findMany({
      where: {
        candidateId: document.candidateId,
        requestKey: { startsWith: `document-return:${documentId}:` },
      },
      orderBy: { createdAt: "desc" },
    });
    return operations.map((row) => this.dto(row));
  }

  private dto(row: { id: string; status: string; providerId: string | null; errorCode: string | null }): CommunicationOperationDto {
    return {
      id: row.id,
      status: row.status as SendStatus,
      providerId: row.providerId,
      errorCode: row.errorCode,
    };
  }
}

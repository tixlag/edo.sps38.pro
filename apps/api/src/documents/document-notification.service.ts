import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LkNotificationService } from "../lk/lk-notification.service";
import { candidateReviewGroup } from "./review-group";

export interface NotifyDocumentUploadedParams {
  documentId: string;
  version: number;
  candidateId?: string | null;
  employeeId?: string | null;
}

@Injectable()
export class DocumentNotificationService {
  private readonly logger = new Logger(DocumentNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly lkNotifications?: LkNotificationService,
  ) {}

  async notifyDocumentUploaded(
    params: NotifyDocumentUploadedParams,
  ): Promise<void> {
    if (!this.lkNotifications) return;
    try {
      const candidateId =
        params.candidateId ??
        (
          await this.prisma.document.findUnique({
            where: { id: params.documentId },
            select: { candidateId: true },
          })
        )?.candidateId;

      if (!candidateId) return;

      const candidate = await this.prisma.candidate.findUnique({
        where: { id: candidateId },
        select: {
          id: true,
          fullName: true,
          managerCode1c: true,
          reviewGroup: true,
          citizenship: true,
          chatUuid: true,
        },
      });

      const managerCode1c = candidate?.managerCode1c?.trim();
      if (!candidate || !managerCode1c) return;

      const doc = await this.prisma.document.findUnique({
        where: { id: params.documentId },
        select: {
          id: true,
          documentType: {
            select: {
              title: true,
              code: true,
            },
          },
        },
      });

      const docTitle =
        doc?.documentType?.title || doc?.documentType?.code || "Документ";
      const candidateName = candidate.fullName?.trim() || "Кандидат";
      const group = candidateReviewGroup(candidate);
      const targetUrl =
        group === "IG"
          ? `/review-ig?candidate=${encodeURIComponent(candidate.id)}`
          : `/review/candidates/${encodeURIComponent(candidate.id)}?document=${encodeURIComponent(params.documentId)}`;

      await this.lkNotifications.sendNotification({
        recipientCodes1c: [managerCode1c],
        title: "Сотрудник загрузил документ",
        content: `Сотрудник **${candidateName}** загрузил документ «${docTitle}».`,
        type: "toast",
        targetType: "candidate_document_upload",
        targetUrl,
        idempotencyKey: `document-upload:${params.documentId}:${params.version}`,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to send document upload notification for doc ${params.documentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

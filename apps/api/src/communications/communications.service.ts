import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "../documents/candidate-identity";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type CommunicationOperation } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { RedisService } from "../redis/redis.module";
import { DocumentAccessService } from "../documents/document-access.service";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { hasAccessRule } from "../auth/access-rules";
import type { AuthPrincipal } from "../auth/auth-principal";
import {
  ChatChannel,
  SendStatus,
  type CommunicationContextDto,
  type CommunicationHistoryDto,
  type CommunicationOperationDto,
  type SendCommunicationDto,
} from "./communications.dto";
import {
  CHAT_MIME_TYPES,
  MAX_CHAT_FILE_BYTES,
  mergeMessages,
} from "./communication-contract";
import {
  CommunicationSourceError,
  ErpCommunicationsClient,
} from "./erp-communications.client";
import { LkChatClient } from "./lk-chat.client";
import { signAttachment, verifyAttachment } from "./chat-attachment-token";

function operationDto(row: CommunicationOperation): CommunicationOperationDto {
  const stale =
    row.status === "PENDING" && Date.now() - row.createdAt.getTime() > 120000;
  return {
    id: row.id,
    status: stale ? SendStatus.UNKNOWN : (row.status as SendStatus),
    providerId: row.providerId,
    errorCode: stale ? "SEND_RESULT_UNKNOWN" : row.errorCode,
  };
}
@Injectable()
export class CommunicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly erp: ErpCommunicationsClient,
    private readonly lk: LkChatClient,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}
  private canSend(principal: AuthPrincipal) {
    return (
      !!principal.code1c &&
      hasAccessRule(principal.accessRules, EdoAccessRule.ACCESS) &&
      hasAccessRule(principal.accessRules, EdoAccessRule.DOCUMENT_REVIEW_RU)
    );
  }
  private assertSend(principal: AuthPrincipal) {
    if (!this.canSend(principal))
      throw new ForbiddenException(
        "Для отправки нужны право проверки документов и код сотрудника",
      );
  }
  async context(
    candidateId: string,
    principal: AuthPrincipal,
  ): Promise<CommunicationContextDto> {
    const candidate = await this.access.candidate(candidateId, principal);
    const unavailableSources: string[] = [];
    let erp: {
      recipients: CommunicationContextDto["recipients"];
      templates: CommunicationContextDto["templates"];
    } = { recipients: [], templates: [] };
    if (candidate.erpUid && !candidate.erpDeleted) {
      try {
        erp = await this.erp.context(
          candidate.erpUid,
          principal.code1c ?? undefined,
        );
      } catch {
        unavailableSources.push("erp");
      }
    } else unavailableSources.push("erp");
    const recipients = [
      ...erp.recipients
        .filter((recipient) => recipient.channel !== ChatChannel.LK)
        .map((recipient) => ({
          ...recipient,
          supportsFiles:
            recipient.channel !== ChatChannel.SMS && recipient.supportsFiles,
        })),
    ];
    if (candidate.chatUuid && this.lk.configured())
      recipients.unshift({
        id: candidate.chatUuid,
        channel: ChatChannel.LK,
        label: "Чат ЛК",
        supportsFiles: true,
      });
    else if (candidate.chatUuid) unavailableSources.push("lk");
    const lkUrl = candidate.chatUuid ? this.lkLink(candidate.chatUuid) : null;
    return {
      recipients,
      templates: erp.templates,
      canSend: this.canSend(principal) && !candidate.erpDeleted,
      lkUrl,
      unavailableSources,
    };
  }
  private lkLink(chatUuid: string) {
    const url = new URL(
      "/public/candidate-chat",
      this.config.get<string>("LK_PUBLIC_BASE_URL") ?? "https://lk.sps38.pro",
    );
    url.searchParams.set("chat_uuid", chatUuid);
    return url.toString();
  }
  async history(
    candidateId: string,
    principal: AuthPrincipal,
    limit = 50,
    cursor?: string,
  ): Promise<CommunicationHistoryDto> {
    const candidate = await this.access.candidate(candidateId, principal);
    let position: { erp?: string | null; lk?: number | null } = {};
    if (cursor) {
      try {
        const raw = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          !raw ||
          typeof raw !== "object" ||
          (raw.erp !== null && typeof raw.erp !== "string") ||
          (raw.lk !== null &&
            (!Number.isSafeInteger(raw.lk) || raw.lk < 0 || raw.lk > 1000000))
        )
          throw new Error();
        position = raw;
      } catch {
        throw new BadRequestException("Invalid history cursor");
      }
    }
    const [erp, lk] = await Promise.allSettled([
      candidate.erpUid && position.erp !== null
        ? this.erp.history(candidate.erpUid, limit, position.erp)
        : Promise.resolve({ items: [], nextCursor: null }),
      candidate.chatUuid && position.lk !== null
        ? this.lk.history(
            candidateId,
            candidate.chatUuid,
            limit,
            position.lk ?? 0,
          )
        : Promise.resolve({ items: [], hasMore: false }),
    ]);
    const unavailableSources: string[] = [];
    if (erp.status === "rejected") unavailableSources.push("erp");
    if (lk.status === "rejected") unavailableSources.push("lk");
    // A failed source keeps its cursor so retrying cannot silently skip history.
    const next = {
      erp:
        erp.status === "fulfilled"
          ? erp.value.nextCursor
          : (position.erp ?? ""),
      lk:
        lk.status === "fulfilled"
          ? lk.value.hasMore
            ? (position.lk ?? 0) + limit
            : null
          : (position.lk ?? 0),
    };
    const secret = this.config.getOrThrow<string>("JWT_SECRET");
    const erpItems =
      erp.status === "fulfilled"
        ? erp.value.items.map((message) => ({
            ...message,
            id: `erp:${message.id}`,
            attachments: message.attachments.map((file) => ({
              ...file,
              id: signAttachment(secret, {
                candidateId,
                source: "erp",
                id: file.id,
                filename: file.filename,
                mimeType: file.mimeType,
              }),
            })),
          }))
        : [];
    return {
      items: mergeMessages(
        erpItems,
        lk.status === "fulfilled" ? lk.value.items : [],
      ),
      nextCursor:
        next.erp !== null || next.lk !== null
          ? Buffer.from(JSON.stringify(next)).toString("base64url")
          : null,
      unavailableSources,
    };
  }
  async upload(
    candidateId: string,
    principal: AuthPrincipal,
    file: { filename: string; mimeType: string; bytes: Buffer },
  ) {
    this.assertSend(principal);
    await this.access.candidate(candidateId, principal);
    if (!file.bytes.length || file.bytes.length > MAX_CHAT_FILE_BYTES)
      throw new BadRequestException("Файл должен быть от 1 байта до 10 МБ");
    if (
      !CHAT_MIME_TYPES.has(file.mimeType) ||
      !file.filename ||
      [...file.filename].some(
        (char) => char.charCodeAt(0) < 32 || char === "/" || char === "\\",
      ) ||
      file.filename.length > 256
    )
      throw new BadRequestException("Недопустимый тип или имя файла");
    const id = randomUUID(),
      storageKey = `communications/${candidateId}/${id}`;
    await this.storage.uploadBuffer(storageKey, file.bytes, file.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.communicationAttachment.create({
          data: {
            id,
            candidateId,
            actorId: principal.uuid,
            filename: file.filename,
            mimeType: file.mimeType,
            sizeBytes: file.bytes.length,
            storageKey,
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: "DOCUMENT_UPLOADED",
          entityType: "CommunicationAttachment",
          entityId: id,
          after: { candidateId, sizeBytes: file.bytes.length },
        });
      });
    } catch (error) {
      await this.storage.delete(storageKey);
      throw error;
    }
    return {
      id,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.length,
    };
  }
  async send(
    candidateId: string,
    principal: AuthPrincipal,
    input: SendCommunicationDto,
  ): Promise<CommunicationOperationDto> {
    this.assertSend(principal);
    const candidate = await this.access.candidate(candidateId, principal);
    const ids = input.attachmentIds ?? [];
    const text = input.text.trim();
    if (
      (!text && !ids.length) ||
      (input.channel === ChatChannel.SMS && ids.length)
    )
      throw new BadRequestException(
        "Сообщение пустое или канал не поддерживает файлы",
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          candidateId,
          channel: input.channel,
          recipientId: input.recipientId,
          text,
          ids,
        }),
      )
      .digest("hex");
    const previous = await this.prisma.communicationOperation.findUnique({
      where: {
        actorId_requestKey: {
          actorId: principal.uuid,
          requestKey: input.requestId,
        },
      },
    });
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ConflictException(
          "Ключ отправки уже использован с другими данными",
        );
      return operationDto(previous);
    }
    const context = await this.context(candidateId, principal);
    if (
      !context.canSend ||
      !context.recipients.some(
        (r) =>
          r.channel === input.channel &&
          r.id === input.recipientId &&
          (!ids.length || r.supportsFiles),
      )
    )
      throw new BadRequestException("Канал или получатель недоступен");
    const files = await this.prisma.communicationAttachment.findMany({
      where: {
        id: { in: ids },
        candidateId,
        actorId: principal.uuid,
        operationId: null,
        createdAt: { gt: new Date(Date.now() - 86400000) },
      },
    });
    if (files.length !== ids.length)
      throw new BadRequestException("Вложение недоступно или уже отправлено");
    const file = files[0]
      ? {
          filename: files[0].filename,
          mimeType: files[0].mimeType,
          bytes: await this.storage.read(
            files[0].storageKey,
            MAX_CHAT_FILE_BYTES,
          ),
        }
      : undefined;
    let operation: CommunicationOperation;
    try {
      operation = await this.prisma.$transaction(async (tx) => {
        const row = await tx.communicationOperation.create({
          data: {
            candidateId,
            actorId: principal.uuid,
            actorCode1c: principal.code1c!,
            requestKey: input.requestId,
            fingerprint,
            channel: input.channel,
            recipientId: input.recipientId,
            text,
          },
        });
        if (ids.length) {
          const reserved = await tx.communicationAttachment.updateMany({
            where: {
              id: { in: ids },
              candidateId,
              actorId: principal.uuid,
              operationId: null,
            },
            data: { operationId: row.id },
          });
          if (reserved.count !== ids.length)
            throw new ConflictException("Вложение уже используется");
        }
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: "COMMUNICATION_REQUESTED",
          entityType: "CommunicationOperation",
          entityId: row.id,
          correlationId: input.requestId,
          after: { candidateId, channel: input.channel },
        });
        return row;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const replay =
          await this.prisma.communicationOperation.findUniqueOrThrow({
            where: {
              actorId_requestKey: {
                actorId: principal.uuid,
                requestKey: input.requestId,
              },
            },
          });
        if (replay.fingerprint !== fingerprint)
          throw new ConflictException("Ключ отправки уже использован");
        return operationDto(replay);
      }
      throw error;
    }
    let result: {
      status: "SENT" | "FAILED" | "UNKNOWN";
      providerId: string | null;
      errorCode: string | null;
    };
    // No automatic replay after a dispatch. The upstream protocols do not all
    // support provider idempotency, so a timeout is explicitly UNKNOWN.
    try {
      const current = await this.access.candidate(candidateId, principal);
      if (
        current.erpDeleted ||
        current.erpUid !== candidate.erpUid ||
        (input.channel === ChatChannel.LK &&
          current.chatUuid !== input.recipientId)
      )
        throw new CommunicationSourceError("CHAT_IDENTITY_CHANGED");
      if (input.channel === ChatChannel.LK) {
        if (!candidate.chatUuid)
          throw new CommunicationSourceError("LK_CHAT_MISSING");
        const providerId = file
          ? await this.lk.sendFile(
              candidate.chatUuid,
              principal.code1c!,
              text,
              file,
              operation.id,
            )
          : await this.lk.sendText(
              candidate.chatUuid,
              principal.code1c!,
              text,
              operation.id,
            );
        result = {
          status: "SENT",
          providerId: providerId || null,
          errorCode: null,
        };
      } else {
        if (!candidate.erpUid)
          throw new CommunicationSourceError("ERP_CANDIDATE_MISSING");
        result = await this.erp.send({
          candidate: candidate.erpUid,
          actor: principal.code1c!,
          requestId: operation.id,
          channel: input.channel,
          recipientId: input.recipientId,
          text,
          ...(file
            ? {
                file: {
                  filename: file.filename,
                  mimeType: file.mimeType,
                  base64: file.bytes.toString("base64"),
                },
              }
            : {}),
        });
      }
    } catch (error) {
      result = {
        status:
          error instanceof CommunicationSourceError && error.uncertain
            ? "UNKNOWN"
            : "FAILED",
        providerId: null,
        errorCode:
          error instanceof CommunicationSourceError
            ? error.code
            : "CHAT_SEND_FAILED",
      };
    }
    const completed = await this.prisma.$transaction(async (tx) => {
      const row = await tx.communicationOperation.update({
        where: { id: operation.id },
        data: result,
      });
      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action: "COMMUNICATION_COMPLETED",
        entityType: "CommunicationOperation",
        entityId: row.id,
        correlationId: input.requestId,
        before: { status: "PENDING" },
        after: result,
      });
      return row;
    });
    return operationDto(completed);
  }
  async operation(candidateId: string, principal: AuthPrincipal, id: string) {
    await this.access.candidate(candidateId, principal);
    const row = await this.prisma.communicationOperation.findFirst({
      where: { id, candidateId, actorId: principal.uuid },
    });
    if (!row) throw new NotFoundException();
    return operationDto(row);
  }
  async link(candidateId: string, principal: AuthPrincipal) {
    this.assertSend(principal);
    const candidate = await this.access.candidate(candidateId, principal);
    if (candidate.chatUuid) return { url: this.lkLink(candidate.chatUuid) };
    if (!candidate.erpUid)
      throw new ServiceUnavailableException("ERP_CANDIDATE_MISSING");
    const lock = `edo:candidate-link:${candidateId}`,
      owner = randomUUID();
    if (!(await this.redis.setNxPxStrict(lock, owner, 60000)))
      throw new ConflictException("Ссылка уже создаётся");
    try {
      const result = await this.erp.link(candidate.erpUid, principal.code1c!);
      await candidateIdentityTransaction(this.prisma, async (tx) => {
        await resolveCandidateIdentity(tx, {
          expectedId: candidateId,
          erpUid: candidate.erpUid,
          chatUuid: result.chatUuid,
          identityKey: `erp-candidate:${candidate.erpUid}`,
        });
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: "CANDIDATE_LINKED",
          entityType: "Candidate",
          entityId: candidateId,
          after: { chatUuid: result.chatUuid },
        });
      });
      return { url: this.lkLink(result.chatUuid) };
    } finally {
      await this.redis.compareAndDelStrict(lock, owner);
    }
  }
  async download(candidateId: string, principal: AuthPrincipal, token: string) {
    const candidate = await this.access.candidate(candidateId, principal);
    const locator = verifyAttachment(
      this.config.getOrThrow<string>("JWT_SECRET"),
      token,
      candidateId,
    );
    if (locator.source === "lk" && locator.chatUuid !== candidate.chatUuid)
      throw new NotFoundException("Вложение больше не принадлежит этому чату");
    const file =
      locator.source === "lk"
        ? {
            filename: locator.filename,
            mimeType: locator.mimeType,
            bytes: await this.lk.download(locator.id),
          }
        : candidate.erpUid
          ? await this.erp.attachment(candidate.erpUid, locator.id)
          : null;
    if (!file) throw new NotFoundException();
    const key = `communications/downloads/${candidateId}/${createHash("sha256").update(token).digest("hex")}`;
    await this.storage.uploadBuffer(key, file.bytes, file.mimeType);
    return { url: await this.storage.downloadUrl(key, file.filename, 60) };
  }
}

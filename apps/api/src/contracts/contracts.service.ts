import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  type SigningContract,
  type SigningContractVersion,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { ownContractWhere, signingCandidateWhere } from "./contract-access";
import { ZupDocumentsClient } from "./zup-documents.client";
import { ContractFileService } from "./contract-file.service";
import { ContractObjectsService } from "./contract-objects.service";
import {
  ConfirmationRole,
  ContractActionDto,
  ContractBank,
  ContractDetailDto,
  ContractDto,
  ContractState,
  ConfirmContractDto,
  CreateContractDto,
} from "./contract.dto";

const relations = {
  versions: { orderBy: { version: "desc" as const }, take: 1 },
  confirmations: { orderBy: { confirmedAt: "asc" as const } },
};
type ContractRecord = Prisma.SigningContractGetPayload<{
  include: typeof relations;
}>;
type Actor = AuthPrincipal;
type Tx = Prisma.TransactionClient;
const key = (actor: Actor, requestId: string) => `${actor.uuid}:${requestId}`;
const conflict = () =>
  new ConflictException(
    "Договор изменился. Обновите страницу и повторите действие.",
  );

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly zup: ZupDocumentsClient,
    private readonly files: ContractFileService,
    private readonly objects: ContractObjectsService,
  ) {}

  async types() {
    return { items: await this.zup.types() };
  }

  async candidate(id: string, actor: Actor) {
    const row = await this.prisma.candidate.findFirst({
      where: { AND: [{ id }, signingCandidateWhere(actor)] },
    });
    if (!row) throw new NotFoundException("Получатель не найден");
    return {
      id: row.id,
      fullName: row.fullName,
      birthDate: row.birthDate?.toISOString().slice(0, 10) ?? null,
      code1c: row.code1c,
    };
  }

  private scope(actor: Actor, own = false): Prisma.SigningContractWhereInput {
    return own
      ? ownContractWhere(actor)
      : { candidate: signingCandidateWhere(actor) };
  }
  private async record(
    id: string,
    actor: Actor,
    own = false,
    db: PrismaService | Tx = this.prisma,
  ): Promise<ContractRecord> {
    const row = await db.signingContract.findFirst({
      where: { AND: [{ id }, this.scope(actor, own)] },
      include: relations,
    });
    if (!row) throw new NotFoundException("Договор не найден");
    return row;
  }
  private dto(row: ContractRecord): ContractDto {
    const file = row.versions.find((v) => v.version === row.currentVersion);
    return {
      id: row.id,
      candidateId: row.candidateId,
      fullName: row.fullName,
      birthDate: row.birthDate?.toISOString().slice(0, 10) ?? null,
      code1c: row.recipientCode1c,
      documentType: row.documentType,
      documentTypeName: row.documentTypeName,
      status: row.status as ContractState,
      revision: row.revision,
      version: row.currentVersion,
      hasFile: !!file,
      filename: file?.filename ?? null,
      createdBy: row.createdBy,
      sentBy: row.sentBy,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      errorMessage: row.errorMessage,
      confirmations: row.confirmations.map((c) => ({
        role: c.role as ConfirmationRole,
        actorId: c.actorId,
        actorLabel: c.actorLabel,
        confirmedAt: c.confirmedAt.toISOString(),
        mode: "demo",
        bank: c.bank as ContractBank | null,
        sha256: c.sha256,
      })),
    };
  }
  async detail(
    id: string,
    actor: Actor,
    own = false,
  ): Promise<ContractDetailDto> {
    const row = await this.record(id, actor, own);
    const file = row.versions.find((v) => v.version === row.currentVersion);
    const [previewUrl, downloadUrl, originalDownloadUrl, journalDownloadUrl] =
      await Promise.all([
        file ? this.storage.previewUrl(file.storageKey, file.filename) : null,
        file ? this.storage.downloadUrl(file.storageKey, file.filename) : null,
        file?.originalKey
          ? this.storage.downloadUrl(
              file.originalKey,
              file.originalFilename ?? "source.docx",
            )
          : null,
        row.journalKey
          ? this.storage.downloadUrl(row.journalKey, "confirmations-demo.json")
          : null,
      ]);
    // The frozen recipient is assigned only at sending. Draft UI still needs current link availability.
    const candidate =
      !own && !row.sentAt
        ? await this.prisma.candidate.findUnique({
            where: { id: row.candidateId },
            select: { code1c: true },
          })
        : null;
    return {
      ...this.dto(row),
      ...(!row.sentAt && candidate ? { code1c: candidate.code1c } : {}),
      previewUrl,
      downloadUrl,
      originalDownloadUrl,
      journalDownloadUrl,
    };
  }
  async list(actor: Actor, candidateId?: string) {
    const rows = await this.prisma.signingContract.findMany({
      where: {
        AND: [this.scope(actor), ...(candidateId ? [{ candidateId }] : [])],
      },
      include: relations,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { items: rows.map((r) => this.dto(r)) };
  }
  async listOwn(actor: Actor) {
    const rows = await this.prisma.signingContract.findMany({
      where: this.scope(actor, true),
      include: relations,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { items: rows.map((r) => this.dto(r)) };
  }

  async create(
    body: CreateContractDto,
    actor: Actor,
    correlationId?: string,
  ): Promise<ContractDetailDto> {
    const requestKey = key(actor, body.requestId);
    const previous = await this.prisma.signingContract.findUnique({
      where: { requestKey },
    });
    if (previous) {
      if (
        previous.candidateId !== body.candidateId ||
        previous.documentType !== body.documentType
      )
        throw conflict();
      return this.detail(previous.id, actor);
    }
    const candidate = await this.candidate(body.candidateId, actor);
    if (!body.manual && (!candidate.fullName?.trim() || !candidate.birthDate))
      throw new BadRequestException(
        "Для формирования договора нужны ФИО и дата рождения получателя",
      );
    const type = body.manual
      ? {
          code: body.documentType,
          name:
            body.documentType === "manual"
              ? "Трудовой договор"
              : body.documentType,
        }
      : (await this.zup.types()).find((t) => t.code === body.documentType);
    if (!type)
      throw new BadRequestException("Выбранный тип договора отсутствует в ЗУП");
    let row: SigningContract;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const allowed = await tx.candidate.findFirst({
          where: {
            AND: [{ id: body.candidateId }, signingCandidateWhere(actor)],
          },
        });
        if (!allowed) throw new NotFoundException("Получатель не найден");
        const created = await tx.signingContract.create({
          data: {
            candidateId: candidate.id,
            requestKey,
            documentType: type.code,
            documentTypeName: type.name,
            fullName: candidate.fullName,
            birthDate: candidate.birthDate
              ? new Date(`${candidate.birthDate}T00:00:00.000Z`)
              : null,
            createdBy: actor.uuid,
            status: body.manual ? "DRAFT" : "PREPARING",
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId: actor.uuid,
          action: "CONTRACT_CREATED",
          entityType: "SigningContract",
          entityId: created.id,
          after: {
            status: created.status,
            candidateId: created.candidateId,
            documentType: created.documentType,
          },
          correlationId,
        });
        return created;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const replay = await this.prisma.signingContract.findUnique({
          where: { requestKey },
        });
        if (
          replay &&
          replay.candidateId === body.candidateId &&
          replay.documentType === body.documentType
        )
          return this.detail(replay.id, actor);
      }
      throw error;
    }
    if (body.manual) return this.detail(row.id, actor);
    try {
      const pdf = await this.zup.generate({
        full_name: candidate.fullName!,
        birth_date: candidate.birthDate!.split("-").reverse().join("."),
        document_type: body.documentType,
      });
      await this.saveVersion(
        row.id,
        { revision: 0, requestId: body.requestId },
        pdf,
        "employment_contract.pdf",
        actor,
        correlationId,
        true,
      );
    } catch (error) {
      const message =
        error instanceof HttpException && error.getStatus() < 500
          ? error.message.slice(0, 512)
          : "Не удалось сформировать договор. Повторите запрос или загрузите готовый файл.";
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.signingContract.updateMany({
          where: { id: row.id, status: "PREPARING", revision: 0 },
          data: {
            status: "FAILED",
            errorMessage: message,
            revision: { increment: 1 },
          },
        });
        if (changed.count)
          await this.audit.logInTransaction(tx, {
            actorId: actor.uuid,
            action: "CONTRACT_PREPARATION_FAILED",
            entityType: "SigningContract",
            entityId: row.id,
            after: { status: "FAILED" },
            correlationId,
          });
      });
      throw error;
    }
    return this.detail(row.id, actor);
  }

  async upload(
    id: string,
    body: ContractActionDto,
    bytes: Buffer,
    filename: string,
    actor: Actor,
    correlationId?: string,
  ) {
    await this.saveVersion(id, body, bytes, filename, actor, correlationId);
    return this.detail(id, actor);
  }
  private async saveVersion(
    id: string,
    body: ContractActionDto,
    bytes: Buffer,
    filename: string,
    actor: Actor,
    correlationId?: string,
    generated = false,
  ) {
    const row = await this.record(id, actor);
    const requestKey = key(actor, body.requestId);
    const previous = await this.prisma.signingContractVersion.findUnique({
      where: { requestKey },
    });
    if (previous) {
      if (previous.contractId !== id) throw conflict();
      return;
    }
    const allowedStates = generated
      ? ["PREPARING"]
      : [
          "DRAFT",
          "FAILED",
          ...(row.updatedAt.getTime() < Date.now() - 10 * 60_000
            ? ["PREPARING"]
            : []),
        ];
    if (!allowedStates.includes(row.status) || row.revision !== body.revision)
      throw conflict();
    const prepared = await this.files.prepare(bytes, filename);
    const storageKey = await this.objects.stage(
      id,
      "document.pdf",
      prepared.pdf,
      "application/pdf",
    );
    const originalKey = prepared.original
      ? await this.objects.stage(
          id,
          "source.docx",
          prepared.original,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
      : null;
    const sha256 = createHash("sha256").update(prepared.pdf).digest("hex");
    try {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.signingContract.updateMany({
          where: {
            AND: [
              { id, revision: body.revision, status: row.status },
              this.scope(actor),
            ],
          },
          data: {
            status: "DRAFT",
            revision: { increment: 1 },
            currentVersion: { increment: 1 },
            errorMessage: null,
          },
        });
        if (changed.count !== 1) throw conflict();
        await tx.signingContractVersion.create({
          data: {
            contractId: id,
            version: row.currentVersion + 1,
            requestKey,
            storageKey,
            originalKey,
            originalFilename: prepared.originalFilename?.slice(0, 255),
            filename: prepared.original
              ? "employment_contract.pdf"
              : filename.replace(/[\\/\r\n]/g, "_").slice(0, 255),
            sizeBytes: prepared.pdf.length,
            sha256,
          },
        });
        await this.objects.retain(tx, [
          storageKey,
          ...(originalKey ? [originalKey] : []),
        ]);
        await this.audit.logInTransaction(tx, {
          actorId: actor.uuid,
          action: "CONTRACT_FILE_REPLACED",
          entityType: "SigningContract",
          entityId: id,
          before: { version: row.currentVersion },
          after: {
            version: row.currentVersion + 1,
            sha256,
            source: generated ? "ZUP" : prepared.original ? "DOCX" : "PDF",
          },
          correlationId,
        });
      });
    } catch (error) {
      const replay = await this.prisma.signingContractVersion.findUnique({
        where: { requestKey },
      });
      if (replay?.contractId === id) return;
      throw error;
    }
  }

  private version(row: ContractRecord): SigningContractVersion {
    const file = row.versions.find((v) => v.version === row.currentVersion);
    if (!file) throw new BadRequestException("Сначала загрузите PDF договора");
    return file;
  }
  private async actorLabel(actor: Actor) {
    const employee = actor.code1c
      ? await this.prisma.lkEmployee.findUnique({
          where: { code1c: actor.code1c },
          select: { fullName: true },
        })
      : null;
    return employee?.fullName ?? actor.code1c ?? actor.uuid;
  }
  async send(
    id: string,
    body: ContractActionDto,
    actor: Actor,
    correlationId?: string,
  ) {
    const row = await this.record(id, actor);
    const requestKey = key(actor, body.requestId);
    const employer = row.confirmations.find((c) => c.role === "employer");
    if (employer?.requestKey === requestKey && employer.actorId === actor.uuid)
      return this.detail(id, actor);
    if (row.status !== "DRAFT" || row.revision !== body.revision)
      throw conflict();
    const file = this.version(row);
    const label = await this.actorLabel(actor);
    try {
      await this.prisma.$transaction(async (tx) => {
        // Recipient-link updates also take the InnoDB row lock; freeze a committed identity.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM candidates WHERE id = ${row.candidateId} FOR UPDATE`,
        );
        const candidate = await tx.candidate.findFirst({
          where: {
            AND: [{ id: row.candidateId }, signingCandidateWhere(actor)],
          },
        });
        if (!candidate?.code1c?.trim())
          throw new BadRequestException(
            "Для отправки привяжите получателя к сотруднику ЛК (code1c)",
          );
        const now = new Date();
        const changed = await tx.signingContract.updateMany({
          where: {
            AND: [
              { id, revision: body.revision, status: "DRAFT" },
              this.scope(actor),
            ],
          },
          data: {
            status: "WAITING_EMPLOYEE",
            sentBy: actor.uuid,
            sentAt: now,
            recipientCode1c: candidate.code1c,
            revision: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw conflict();
        await tx.signingContractConfirmation.create({
          data: {
            contractId: id,
            version: row.currentVersion,
            role: "employer",
            actorId: actor.uuid,
            actorLabel: label,
            mode: "demo",
            sha256: file.sha256,
            requestKey,
            confirmedAt: now,
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId: actor.uuid,
          action: "CONTRACT_SENT",
          entityType: "SigningContract",
          entityId: id,
          before: { status: row.status },
          after: {
            status: "WAITING_EMPLOYEE",
            version: row.currentVersion,
            sha256: file.sha256,
            mode: "demo",
          },
          correlationId,
        });
      });
    } catch (error) {
      const replay = await this.prisma.signingContractConfirmation.findUnique({
        where: { requestKey },
      });
      if (
        replay?.contractId !== id ||
        replay.actorId !== actor.uuid ||
        replay.role !== "employer"
      )
        throw error;
    }
    return this.detail(id, actor);
  }

  async confirm(
    id: string,
    body: ConfirmContractDto,
    actor: Actor,
    correlationId?: string,
  ) {
    const row = await this.record(id, actor, true);
    const requestKey = key(actor, body.requestId);
    const replay = row.confirmations.find((c) => c.role === "employee");
    if (
      replay?.requestKey === requestKey &&
      replay.actorId === actor.uuid &&
      replay.bank === body.bank
    )
      return this.detail(id, actor, true);
    if (row.status !== "WAITING_EMPLOYEE" || row.revision !== body.revision)
      throw conflict();
    const file = this.version(row);
    if (
      !row.sentBy ||
      !row.confirmations.some(
        (c) =>
          c.role === "employer" &&
          c.sha256 === file.sha256 &&
          c.version === row.currentVersion,
      )
    )
      throw conflict();
    const label = await this.actorLabel(actor);
    const now = new Date();
    const confirmation = {
      role: "employee",
      actorId: actor.uuid,
      actorLabel: label,
      confirmedAt: now.toISOString(),
      mode: "demo",
      bank: body.bank,
      sha256: file.sha256,
    };
    const journal = {
      format: "edo-contract-confirmations-v1",
      mode: "demo",
      contractId: id,
      version: row.currentVersion,
      sha256: file.sha256,
      documentKey: file.storageKey,
      originalKey: file.originalKey,
      recipientCode1c: row.recipientCode1c,
      confirmations: [...this.dto(row).confirmations, confirmation],
    };
    const journalKey = await this.objects.stage(
      id,
      "confirmations-demo.json",
      Buffer.from(JSON.stringify(journal, null, 2)),
      "application/json",
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.signingContract.updateMany({
          where: {
            AND: [
              { id, revision: body.revision, status: "WAITING_EMPLOYEE" },
              this.scope(actor, true),
            ],
          },
          data: {
            status: "COMPLETED",
            revision: { increment: 1 },
            completedAt: now,
            journalKey,
          },
        });
        if (changed.count !== 1) throw conflict();
        await tx.signingContractConfirmation.create({
          data: {
            contractId: id,
            version: row.currentVersion,
            role: "employee",
            actorId: actor.uuid,
            actorLabel: label,
            mode: "demo",
            bank: body.bank,
            sha256: file.sha256,
            requestKey,
            confirmedAt: now,
          },
        });
        await this.objects.retain(tx, [journalKey]);
        await tx.signingContractNotification.create({
          data: {
            contractId: id,
            recipientId: row.sentBy!,
            kind: "completed",
            message:
              `Сотрудник подписал договор: ${row.fullName ?? "получатель"}`.slice(
                0,
                512,
              ),
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId: actor.uuid,
          action: "CONTRACT_CONFIRMED",
          entityType: "SigningContract",
          entityId: id,
          before: { status: row.status },
          after: {
            status: "COMPLETED",
            version: row.currentVersion,
            sha256: file.sha256,
            mode: "demo",
            bank: body.bank,
          },
          correlationId,
        });
      });
    } catch (error) {
      const replay = await this.prisma.signingContractConfirmation.findUnique({
        where: { requestKey },
      });
      if (
        replay?.contractId !== id ||
        replay.actorId !== actor.uuid ||
        replay.role !== "employee" ||
        replay.bank !== body.bank
      )
        throw error;
    }
    return this.detail(id, actor, true);
  }

  async decline(
    id: string,
    body: ContractActionDto,
    actor: Actor,
    correlationId?: string,
  ) {
    const row = await this.record(id, actor, true);
    const requestKey = key(actor, body.requestId);
    if (row.declineRequestKey === requestKey)
      return this.detail(id, actor, true);
    if (row.status !== "WAITING_EMPLOYEE" || row.revision !== body.revision)
      throw conflict();
    try {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.signingContract.updateMany({
          where: {
            AND: [
              { id, revision: body.revision, status: "WAITING_EMPLOYEE" },
              this.scope(actor, true),
            ],
          },
          data: {
            status: "DECLINED",
            revision: { increment: 1 },
            declineRequestKey: requestKey,
          },
        });
        if (changed.count !== 1) throw conflict();
        await tx.signingContractNotification.create({
          data: {
            contractId: id,
            recipientId: row.sentBy!,
            kind: "declined",
            message:
              `Сотрудник отказался от договора: ${row.fullName ?? "получатель"}`.slice(
                0,
                512,
              ),
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId: actor.uuid,
          action: "CONTRACT_DECLINED",
          entityType: "SigningContract",
          entityId: id,
          before: { status: row.status },
          after: { status: "DECLINED" },
          correlationId,
        });
      });
    } catch (error) {
      const replay = await this.prisma.signingContract.findUnique({
        where: { id },
      });
      if (replay?.declineRequestKey !== requestKey) throw error;
    }
    return this.detail(id, actor, true);
  }

  async notifications(actor: Actor) {
    const rows = await this.prisma.signingContractNotification.findMany({
      where: { recipientId: actor.uuid, contract: this.scope(actor) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        contractId: row.contractId,
        message: row.message,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      })),
    };
  }
  async readNotification(id: string, actor: Actor) {
    const where = { id, recipientId: actor.uuid, contract: this.scope(actor) };
    const updated = await this.prisma.signingContractNotification.updateMany({
      where: { ...where, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.prisma.signingContractNotification.findFirst({
      where,
    });
    if (!row) throw new NotFoundException("Уведомление не найдено");
    void updated;
    return {
      id: row.id,
      contractId: row.contractId,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    };
  }
}

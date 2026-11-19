import { reviewGroupWhere } from "./review-group";
import { createHash } from "node:crypto";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  ErpWorkspaceClient,
  previousDocumentsSchema,
  uuid,
} from "./erp-workspace.client";

const MAX_HISTORY_CARD_LOOKUPS = 8;
const RU_CREDIT_SOURCE_TTL_MS = 30_000;

export function safeHistoricalMime(value: string | null | undefined) {
  const normalized = value?.split(";")[0].trim().toLowerCase();
  return normalized &&
    ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
      normalized,
    )
    ? normalized
    : "application/octet-stream";
}

@Injectable()
export class OwnDocumentHistoryService {
  private readonly ruCreditSources = new Map<
    string,
    { expiresAt: number; source: Promise<{ erpUid: string; personUid: string } | null> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly storage: StorageService,
  ) {}

  private async previousScope(code1c: string) {
    const state = await this.prisma.igEmploymentState.findUnique({
      where: { code1c },
      include: { currentCandidate: { select: { personUid: true } } },
    });
    if (!state?.currentCandidateId) return null;
    return {
      code1c,
      id: { not: state.currentCandidateId },
      AND: [
        reviewGroupWhere("IG"),
        {
          OR: [
            { personUid: null },
            ...(state.currentCandidate?.personUid
              ? [{ personUid: state.currentCandidate.personUid }]
              : []),
          ],
        },
      ],
    };
  }

  private async currentIdentity(code1c: string, signal?: AbortSignal) {
    return this.erp.identity(code1c, signal).catch((error) => {
      if (
        error instanceof ConflictException &&
        error.message === "CURRENT_CANDIDATE_CONFIRMATION_REQUIRED"
      )
        return null;
      throw error;
    });
  }

  resolveRuCreditSource(code1c: string) {
    const now = Date.now();
    const cached = this.ruCreditSources.get(code1c);
    if (cached && cached.expiresAt > now) return cached.source;
    if (this.ruCreditSources.size >= 500) this.ruCreditSources.clear();
    const source = (async () => {
      const signal = AbortSignal.timeout(12_000);
      const identity = await this.currentIdentity(code1c, signal);
      if (identity && (identity.code1C !== code1c || identity.recipientType !== "candidate"))
        return null;
      const { card, personUid } = await this.erpCandidateCard(code1c, identity?.erpUid, signal);
      if (!identity && !card.employmentConfirmed) return null;
      return { erpUid: card.erpUid, personUid };
    })().catch(() => null);
    this.ruCreditSources.set(code1c, { expiresAt: now + RU_CREDIT_SOURCE_TTL_MS, source });
    return source;
  }

  private async erpHistory(code1c: string) {
    const employee = await this.prisma.lkEmployee.findUnique({
      where: { code1c },
      select: { uuid: true, sourcePresent: true },
    });
    if (employee && !employee.sourcePresent) throw new NotFoundException();
    // Keep access for employees whose LK projection has not arrived yet.
    const identity = employee ? null : await this.erp.identity(code1c);
    if (identity && identity.code1C !== code1c) throw new NotFoundException();
    const person = uuid.safeParse(employee?.uuid ?? identity?.personUid);
    if (!person.success) throw new NotFoundException();
    const personUid = person.data;
    const result = await this.erp.request(
      "employee-document-history",
      previousDocumentsSchema,
      { code1c, personUid },
    );
    return {
      items: result.items.filter((doc) => !doc.personUid || doc.personUid === personUid),
      open: (id: string) => this.erp.employeeHistoryOriginal(code1c, personUid, id),
    };
  }

  private async erpCandidateCard(
    code1c: string,
    confirmedUid: string | null | undefined,
    signal: AbortSignal,
  ) {
    const employee = await this.prisma.lkEmployee.findUnique({
      where: { code1c },
      select: { uuid: true, fullName: true, birthday: true, sourcePresent: true },
    });
    if (!employee?.sourcePresent) throw new NotFoundException();
    const person = uuid.safeParse(employee.uuid);
    if (!person.success) throw new NotFoundException();
    // Names and dates only narrow the catalog lookup. ERP confirms ownership.
    const birthDate = employee.birthday?.toISOString().slice(0, 10);
    const hints = confirmedUid
      ? [{ erpUid: confirmedUid }]
      : await this.prisma.candidate.findMany({
          where: {
            erpDeleted: false,
            erpUid: { not: null },
            reviewGroup: "RU",
            OR: [
              { personUid: person.data },
              { code1c },
              ...(birthDate
                ? [{ fullName: employee.fullName, birthDate: new Date(birthDate) }]
                : []),
            ],
          },
          select: { erpUid: true },
          take: MAX_HISTORY_CARD_LOOKUPS + 1,
        });
    if (hints.length > MAX_HISTORY_CARD_LOOKUPS) throw new NotFoundException();
    const matches = await Promise.all(
      hints.map(async ({ erpUid }) => {
        if (!erpUid) return null;
        const card = await this.erp.card(erpUid, signal).catch((error) => {
          if (error instanceof NotFoundException) return null;
          throw error;
        });
        return card?.erpUid === erpUid.toLowerCase() &&
          card.code1C === code1c &&
          card.personUid === person.data
          ? card
          : null;
      }),
    );
    const verified = matches.filter((card) => card !== null);
    if (verified.length !== 1 || !verified[0]) throw new NotFoundException();
    return { card: verified[0], personUid: person.data };
  }

  async list(code1c: string) {
    const scope = await this.previousScope(code1c);
    const documents = scope
      ? await this.prisma.document.findMany({
          where: { candidate: scope, currentVersion: { gt: 0 } },
          include: {
            documentType: true,
            versions: {
              include: { files: { orderBy: { ordinal: "asc" } } },
              orderBy: { version: "desc" },
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];
    const items = documents.flatMap((doc) =>
      doc.versions.flatMap((version) => {
        const files = version.files.length
          ? version.files
              .filter((file) => !file.deletedAt)
              .map((file) => ({ id: file.id, name: file.filename }))
          : version.storageKey
            ? [
                {
                  id: `legacy-${version.id}`,
                  name: `Версия ${version.version}`,
                },
              ]
            : [];
        return [
          {
            source: "EDO" as const,
            id: doc.id,
            title: doc.documentType?.title ?? "Документ",
            files,
          },
        ];
      }),
    );
    try {
      const history = await this.erpHistory(code1c);
      return {
        erpAvailable: true,
        items: [
          ...items,
          ...history.items.map((doc) => ({
            source: "ERP" as const,
            id: doc.id,
            title: doc.title,
            files: doc.originalAvailable
              ? [{ id: "original", name: "Открыть оригинал" }]
              : [],
          })),
        ],
      };
    } catch {
      return { erpAvailable: false, items };
    }
  }

  async probeOriginal(
    key: string,
    size: number,
    sha256: string | null,
  ): Promise<boolean> {
    if (
      !sha256 ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      size <= 0 ||
      size > 100 * 1024 * 1024
    )
      return false;
    const stream = await this.storage.openRead(
      key,
      AbortSignal.timeout(30_000),
      100 * 1024 * 1024,
    );
    let length = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of stream) {
        length += chunk.length;
        if (length > size) return false;
        hash.update(chunk);
      }
      return length === size && hash.digest("hex") === sha256;
    } finally {
      stream.destroy();
    }
  }

  async edoFile(code1c: string, documentId: string, fileId: string) {
    const scope = await this.previousScope(code1c);
    if (!scope) throw new NotFoundException();
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, candidate: scope },
      include: { versions: { include: { files: true } } },
    });
    if (!document) throw new NotFoundException();
    for (const version of document.versions) {
      const file = version.files.find(
        (item) => item.id === fileId && !item.deletedAt,
      );
      if (file)
        return {
          bytes: await this.storage.read(file.storageKey),
          mimeType: safeHistoricalMime(file.mimeType),
        };
      if (
        fileId === `legacy-${version.id}` &&
        !version.files.length &&
        version.storageKey
      )
        return {
          bytes: await this.storage.read(version.storageKey),
          mimeType: safeHistoricalMime(version.mimeType),
        };
    }
    throw new NotFoundException();
  }

  async erpFile(code1c: string, documentId: string) {
    const history = await this.erpHistory(code1c);
    if (
      !history.items.some(
        (doc) => doc.id === documentId && doc.originalAvailable,
      )
    )
      throw new NotFoundException();
    const file = await history.open(documentId);
    return { ...file, mimeType: safeHistoricalMime(file.mimeType) };
  }
}

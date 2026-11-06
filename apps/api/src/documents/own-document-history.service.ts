import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  ErpWorkspaceClient,
  previousDocumentsSchema,
} from "./erp-workspace.client";

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
      chatUuid: null,
      AND: [
        { OR: [{ citizenship: null }, { citizenship: { not: "ru" } }] },
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

  private async erpHistory(code1c: string) {
    const identity = await this.erp.identity(code1c);
    if (
      identity.reviewGroup !== "IG" ||
      identity.recipientType !== "person" ||
      !identity.personUid ||
      identity.code1C !== code1c
    )
      throw new NotFoundException();
    const result = await this.erp.request(
      "person-documents-by-code",
      previousDocumentsSchema,
      { code1c, personUid: identity.personUid },
    );
    return { identity, items: result.items };
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
    const file = await this.erp.personOriginal(
      code1c,
      history.identity.personUid!,
      documentId,
    );
    return { ...file, mimeType: safeHistoricalMime(file.mimeType) };
  }
}

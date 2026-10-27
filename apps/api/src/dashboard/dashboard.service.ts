import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, type DocumentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { canReviewGroup, type ReviewGroup } from "../documents/review-group";
import type {
  DashboardQueryDto,
  DashboardResponseDto,
  KpiDto,
} from "./dto/dashboard-response.dto";

const GROUP = Prisma.sql`CASE WHEN c.chatUuid IS NOT NULL OR c.citizenship = 'ru' THEN 'RU' ELSE 'IG' END`;
const FROM = Prisma.sql`FROM documents d JOIN candidates c ON c.id = d.candidateId JOIN document_versions v ON v.documentId = d.id AND v.version = d.currentVersion LEFT JOIN document_submissions s ON s.versionId = v.id`;
const WEEK_FROM = Prisma.sql`FROM documents d JOIN candidates c ON c.id = d.candidateId JOIN document_versions v ON v.documentId = d.id LEFT JOIN document_submissions s ON s.versionId = v.id`;
const LABELS: Record<DocumentStatus, string> = {
  DRAFT: "Черновики",
  UPLOADED: "Загружены",
  OCR_PENDING: "Распознаются",
  OCR_FAILED: "Ошибка распознавания",
  IN_REVIEW: "На проверке",
  RETURNED: "Возвращены",
  APPROVED: "Подтверждены",
  SIGNED: "Подписаны",
  EXPIRED: "Просрочены",
};
const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
type CountRow = {
  reviewGroup: ReviewGroup;
  status: DocumentStatus;
  documents: bigint | number;
  candidates: bigint | number;
};
type WeekRow = {
  reviewGroup: ReviewGroup;
  day: string;
  value: bigint | number;
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    principal?: AuthPrincipal,
    query: DashboardQueryDto = {},
  ): Promise<DashboardResponseDto> {
    if (!principal) throw new UnauthorizedException("Missing principal");
    const groups = (["RU", "IG"] as const).filter((group) =>
      canReviewGroup(principal, group),
    );
    if (
      query.reviewGroup &&
      query.reviewGroup !== "ALL" &&
      !groups.includes(query.reviewGroup)
    )
      throw new ForbiddenException(
        "Missing required EDO review group access rule",
      );
    const selectors = [
      query.managerCode1c,
      query.managerName,
      query.managerUnassigned === true,
    ].filter(Boolean);
    if (selectors.length > 1)
      throw new BadRequestException("Choose one manager selector");
    const selected =
      query.reviewGroup && query.reviewGroup !== "ALL"
        ? [query.reviewGroup]
        : groups;
    const empty = {
      source: "database",
      kpis: [],
      weekly: [],
      stages: [],
      activity: [],
      blocked: [],
      tasks: [],
      sections: [],
      managers: [],
      attention: [],
    };
    if (!selected.length) return empty;
    const manager = query.managerCode1c
      ? Prisma.sql`c.managerCode1c = ${query.managerCode1c}`
      : query.managerName
        ? Prisma.sql`(c.managerCode1c IS NULL OR c.managerCode1c = '') AND c.managerName = ${query.managerName}`
        : query.managerUnassigned
          ? Prisma.sql`(c.managerCode1c IS NULL OR c.managerCode1c = '') AND (c.managerName IS NULL OR TRIM(c.managerName) = '')`
          : Prisma.sql`1=1`;
    const group =
      selected.length === 2
        ? Prisma.sql`1=1`
        : selected[0] === "RU"
          ? Prisma.sql`(c.chatUuid IS NOT NULL OR c.citizenship = 'ru')`
          : Prisma.sql`(c.chatUuid IS NULL AND (c.citizenship IS NULL OR c.citizenship <> 'ru'))`;
    // Reused by every collection, including facets and own activity. Joining
    // the exact current version excludes staged uploads and historical returns.
    const departmentScope = Prisma.sql`d.currentVersion > 0 AND d.status <> 'DRAFT' AND (s.id IS NULL OR s.status = 'SUCCEEDED') AND ${group}`;
    const scope = Prisma.sql`${departmentScope} AND (${manager})`;
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const end = new Date(monday.getTime() + 7 * 86400_000);
    const [counts, week, managers, attention, activity] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(
        Prisma.sql`SELECT ${GROUP} AS reviewGroup, d.status, COUNT(*) AS documents, COUNT(DISTINCT c.id) AS candidates ${FROM} WHERE ${scope} GROUP BY reviewGroup, d.status`,
      ),
      this.prisma.$queryRaw<WeekRow[]>(
        Prisma.sql`SELECT ${GROUP} AS reviewGroup, DATE_FORMAT(v.submittedAt, '%Y-%m-%d') AS day, COUNT(*) AS value ${WEEK_FROM} WHERE ${scope} AND v.submittedAt >= ${monday} AND v.submittedAt < ${end} GROUP BY reviewGroup, day`,
      ),
      this.prisma.$queryRaw<
        Array<{ name: string | null; code1c: string | null }>
      >(
        Prisma.sql`SELECT c.managerName AS name, c.managerCode1c AS code1c ${FROM} WHERE ${departmentScope} GROUP BY c.managerCode1c, c.managerName ORDER BY c.managerName, c.managerCode1c LIMIT 500`,
      ),
      this.prisma.$queryRaw<DashboardResponseDto["attention"]>(
        Prisma.sql`SELECT d.id AS documentId, c.id AS candidateId, c.fullName, COALESCE(t.title, 'Документ') AS title, d.status, ${GROUP} AS reviewGroup ${FROM} LEFT JOIN document_types t ON t.id = d.documentTypeId WHERE ${scope} AND d.status IN ('IN_REVIEW', 'RETURNED', 'OCR_FAILED') ORDER BY v.submittedAt ASC, d.id ASC LIMIT 10`,
      ),
      this.prisma.$queryRaw<Array<{ action: string; time: Date }>>(
        Prisma.sql`SELECT a.action, a.createdAt AS time FROM audit_logs a WHERE a.actorId = ${principal.uuid} AND a.action IN ('DOCUMENT_UPLOADED', 'DOCUMENT_FIELDS_UPDATED', 'DOCUMENT_RETURNED', 'DOCUMENT_APPROVED', 'DOCUMENT_SIGNED', 'DOCUMENT_OCR_RETRIED') AND EXISTS (SELECT 1 ${FROM} WHERE ${scope} AND ((a.entityType = 'Document' AND a.entityId = d.id) OR (a.entityType = 'Candidate' AND a.entityId = c.id))) ORDER BY a.createdAt DESC, a.id DESC LIMIT 5`,
      ),
    ]);
    const metrics = (rows: CountRow[]): KpiDto[] => {
      const docs = (...statuses: DocumentStatus[]) =>
        rows
          .filter((row) => statuses.includes(row.status))
          .reduce((sum, row) => sum + Number(row.documents), 0);
      const candidates = rows
        .filter((row) => row.status === "IN_REVIEW")
        .reduce((sum, row) => sum + Number(row.candidates), 0);
      return [
        {
          key: "queue",
          label: "Очередь проверки",
          value: String(docs("IN_REVIEW")),
          hint: "документов ждут проверки",
          group: "review",
        },
        {
          key: "in_review",
          label: "Кандидаты на проверке",
          value: String(candidates),
          hint: "кандидатов с документами на проверке",
          group: "review",
        },
        {
          key: "rework",
          label: "Возвращены",
          value: String(docs("RETURNED")),
          hint: "документов сейчас возвращено",
          group: "review",
        },
        {
          key: "approved",
          label: "Подтверждены",
          value: String(docs("APPROVED", "SIGNED")),
          hint: "подтверждённых и подписанных документов",
          group: "review",
        },
        {
          key: "ocr_failed",
          label: "Ошибка распознавания",
          value: String(docs("OCR_FAILED")),
          hint: "документов требуют внимания",
          group: "review",
        },
      ];
    };
    const weekly = (rows: WeekRow[]) =>
      DAYS.map((day, index) => ({
        day,
        value: rows
          .filter(
            (row) =>
              row.day ===
              new Date(monday.getTime() + index * 86400_000)
                .toISOString()
                .slice(0, 10),
          )
          .reduce((sum, row) => sum + Number(row.value), 0),
      }));
    const stages = (rows: CountRow[]) =>
      Object.entries(LABELS)
        .filter(([status]) => status !== "DRAFT")
        .map(([status, label]) => ({
          label,
          value: rows
            .filter((row) => row.status === status)
            .reduce((sum, row) => sum + Number(row.documents), 0),
        }));
    const managerOptions = new Map<
      string,
      { key: string; name: string; code1c: string | null }
    >();
    for (const row of managers) {
      const code = row.code1c?.trim() || null,
        name = row.name?.trim() || null;
      const key = code
        ? `code:${code}`
        : name
          ? `name:${row.name}`
          : "unassigned";
      managerOptions.set(key, {
        key,
        name: name ?? code ?? "Без менеджера",
        code1c: code,
      });
    }
    const actions: Record<string, string> = {
      DOCUMENT_UPLOADED: "Загружен документ",
      DOCUMENT_FIELDS_UPDATED: "Исправлены поля документа",
      DOCUMENT_RETURNED: "Возвращён документ",
      DOCUMENT_APPROVED: "Подтверждён документ",
      DOCUMENT_SIGNED: "Подписан документ",
      DOCUMENT_OCR_RETRIED: "Повторное распознавание документа",
    };
    return {
      ...empty,
      kpis: metrics(counts),
      weekly: weekly(week),
      stages: stages(counts),
      sections: selected.map((reviewGroup) => ({
        reviewGroup,
        kpis: metrics(counts.filter((row) => row.reviewGroup === reviewGroup)),
        weekly: weekly(week.filter((row) => row.reviewGroup === reviewGroup)),
        stages: stages(counts.filter((row) => row.reviewGroup === reviewGroup)),
      })),
      managers: [...managerOptions.values()],
      attention,
      activity: activity.map((row) => ({
        kind: "check",
        title: actions[row.action] ?? "Действие с документом",
        time: new Date(row.time).toISOString(),
      })),
    };
  }
}

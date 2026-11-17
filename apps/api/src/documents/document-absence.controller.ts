import { requiredApplicable } from "./document-contract";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { DocumentAccessService } from "./document-access.service";
import { candidateReviewGroup, requireReviewGroup } from "./review-group";
import { ApiErrorDto } from "./dto/document.dto";

class ReportAbsenceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentTypeId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  documentTypeCode?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(4000) reason!: string;
}
class DecideAbsenceDto {
  @ApiProperty({ enum: ["APPROVED", "REJECTED"] })
  @IsIn(["APPROVED", "REJECTED"])
  status!: "APPROVED" | "REJECTED";
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string;
}
class AbsenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() candidateId!: string;
  @ApiProperty() documentTypeId!: string;
  @ApiProperty() documentTypeCode!: string;
  @ApiProperty() documentTypeTitle!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ["PENDING", "APPROVED", "REJECTED"] }) status!: string;
  @ApiProperty() requestedBy!: string;
  @ApiProperty({ nullable: true, type: String }) decidedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionComment!:
    | string
    | null;
  @ApiProperty({ nullable: true, format: "date-time", type: String })
  decidedAt!: Date | null;
}
@Injectable()
export class DocumentAbsenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: DocumentAccessService,
  ) {}
  async list(candidateId: string, principal: AuthPrincipal) {
    await this.access.candidate(candidateId, principal);
    const rows = await this.prisma.candidateDocumentAbsence.findMany({
      where: { candidateId },
      orderBy: { createdAt: "asc" },
      include: { documentType: true },
    });
    return rows.map((row) => ({
      ...row,
      documentTypeCode: row.documentType.code,
      documentTypeTitle: row.documentType.title,
    }));
  }
  async write(
    candidateId: string,
    principal: AuthPrincipal,
    correlationId: string,
    body: ReportAbsenceDto | DecideAbsenceDto,
    id?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id=${candidateId} FOR UPDATE`;
      const candidate = await tx.candidate.findFirst({
        where: { id: candidateId, ...this.access.candidateWhere(principal) },
      });
      if (!candidate) throw new NotFoundException("CANDIDATE_NOT_FOUND");
      if (candidateReviewGroup(candidate) !== "RU")
        throw new BadRequestException("DOCUMENT_ABSENCE_RU_ONLY");
      if (id) requireReviewGroup(principal, "RU");
      const before = id
        ? await tx.candidateDocumentAbsence.findFirst({
            where: { id, candidateId },
          })
        : null;
      if (id && !before)
        throw new NotFoundException("DOCUMENT_ABSENCE_NOT_FOUND");
      const requestedTypeId =
        "reason" in body ? body.documentTypeId : before?.documentTypeId;
      const requestedCode =
        "reason" in body ? body.documentTypeCode : undefined;
      if (!requestedTypeId && !requestedCode)
        throw new BadRequestException("DOCUMENT_TYPE_REQUIRED");
      const type = await tx.documentType.findFirst({
        where: {
          ...(requestedTypeId ? { id: requestedTypeId } : {}),
          ...(requestedCode ? { code: requestedCode } : {}),
          catalogSyncedAt: { not: null },
        },
        include: {
          positions: true,
          stageRules: {
            include: { positions: true, projects: true, countries: true },
          },
        },
      });
      if (!type) throw new BadRequestException("DOCUMENT_TYPE_NOT_FOUND");
      if (
        !candidate.citizenship ||
        !requiredApplicable(
          type,
          candidate.positionCode ?? "",
          candidate.citizenship,
          candidate.sexKnown
            ? (candidate.sex as "male" | "female" | null)
            : null,
          candidate.projectCode,
        )
      )
        throw new BadRequestException("DOCUMENT_ABSENCE_REQUIRED_TYPE_ONLY");
      let result;
      if ("reason" in body) {
        if (!body.reason.trim())
          throw new BadRequestException("ABSENCE_REASON_REQUIRED");
        result = await tx.candidateDocumentAbsence.upsert({
          where: {
            candidateId_documentTypeId: {
              candidateId,
              documentTypeId: type.id,
            },
          },
          create: {
            candidateId,
            documentTypeId: type.id,
            reason: body.reason.trim(),
            requestedBy: principal.uuid,
          },
          update: {
            reason: body.reason.trim(),
            requestedBy: principal.uuid,
            status: "PENDING",
            decidedBy: null,
            decidedAt: null,
            decisionComment: null,
          },
        });
      } else {
        result = await tx.candidateDocumentAbsence.update({
          where: { id },
          data: {
            status: body.status,
            decisionComment: body.comment?.trim() || null,
            decidedBy: principal.uuid,
            decidedAt: new Date(),
          },
        });
      }
      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action: id ? "DOCUMENT_ABSENCE_DECIDED" : "DOCUMENT_ABSENCE_REPORTED",
        entityType: "Candidate",
        entityId: candidateId,
        correlationId,
        before: before ? { id: before.id, status: before.status } : undefined,
        after: {
          absenceId: result.id,
          documentTypeId: result.documentTypeId,
          reason: result.reason,
          status: result.status,
          decisionComment: result.decisionComment,
        },
      });
      return {
        ...result,
        documentTypeCode: type.code,
        documentTypeTitle: type.title,
      };
    });
  }
}
@ApiTags("documents")
@ApiBearerAuth("access-jwt")
@RequireAccessRule(
  EdoAccessRule.EMPLOYEE_MANAGE,
  EdoAccessRule.DOCUMENT_REVIEW_RU,
)
@ApiResponse({ status: 400, type: ApiErrorDto })
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@ApiResponse({ status: 404, type: ApiErrorDto })
@Controller("v1/candidates/:candidateId/document-absences")
export class DocumentAbsenceController {
  constructor(private readonly service: DocumentAbsenceService) {}
  @Get()
  @ApiOperation({
    operationId: "listCandidateDocumentAbsences",
    summary: "Document absence requests and reviewer decisions",
  })
  @ApiResponse({ status: 200, type: [AbsenceDto] })
  list(
    @Param("candidateId") id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.service.list(id, principal);
  }
  @Post()
  @ApiOperation({
    operationId: "reportCandidateDocumentAbsence",
    summary: "Report a missing RU candidate document",
  })
  @ApiResponse({ status: 201, type: AbsenceDto })
  report(
    @Param("candidateId") id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: ReportAbsenceDto,
    @Req() req: { correlationId: string },
  ) {
    return this.service.write(id, principal, req.correlationId, body);
  }
  @Post(":absenceId/decision")
  @ApiOperation({
    operationId: "decideCandidateDocumentAbsence",
    summary: "Approve or reject a RU document waiver",
  })
  @ApiResponse({ status: 201, type: AbsenceDto })
  decide(
    @Param("candidateId") id: string,
    @Param("absenceId") absenceId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: DecideAbsenceDto,
    @Req() req: { correlationId: string },
  ) {
    return this.service.write(
      id,
      principal,
      req.correlationId,
      body,
      absenceId,
    );
  }
}

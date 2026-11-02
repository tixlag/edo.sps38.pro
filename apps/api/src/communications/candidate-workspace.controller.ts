import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { CatalogDocumentTypesDto, ApiErrorDto } from "../documents/dto/document.dto";
import { CandidateWorkspaceService } from "./candidate-workspace.service";
import {
  CandidatePersonLinkDto,
  CandidatePreviousDocumentsDto,
  CandidateRecheckRequestDto,
  CandidateReferenceQueryDto,
  CandidateReferencesDto,
  CandidateStatusRequestDto,
  CandidateWorkspaceDto,
  CreateCandidateDto,
  UpdateCandidateDto,
} from "./candidate-workspace.dto";
const Errors = () =>
  applyDecorators(
    ...[400, 401, 403, 404, 409, 500, 503].map((status) =>
      ApiResponse({ status, type: ApiErrorDto }),
    ),
  );
@ApiTags("candidate-workspace")
@ApiBearerAuth("access-jwt")
@Errors()
@RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW_RU)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
@Controller("v1/candidates")
export class CandidateWorkspaceController {
  constructor(private readonly workspace: CandidateWorkspaceService) {}
  @Get("references/managers")
  @ApiOperation({
    operationId: "listCandidateManagers",
    summary: "ERP managers",
  })
  @ApiResponse({ status: 200, type: CandidateReferencesDto })
  managers(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query() q: CandidateReferenceQueryDto,
  ) {
    return this.workspace.references("managers", p, q.q);
  }
  @Get("references/positions")
  @ApiOperation({
    operationId: "listCandidatePositions",
    summary: "ERP positions",
  })
  @ApiResponse({ status: 200, type: CandidateReferencesDto })
  positions(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query() q: CandidateReferenceQueryDto,
  ) {
    return this.workspace.references("positions", p, q.q);
  }
  @Get("references/projects")
  @ApiOperation({
    operationId: "listCandidateProjects",
    summary: "ERP projects",
  })
  @ApiResponse({ status: 200, type: CandidateReferencesDto })
  projects(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query() q: CandidateReferenceQueryDto,
  ) {
    return this.workspace.references("projects", p, q.q);
  }
  @Get("references/statuses")
  @ApiOperation({
    operationId: "listCandidateStatuses",
    summary: "All ERP candidate statuses and business transition requirements",
  })
  @ApiResponse({ status: 200, type: CandidateReferencesDto })
  statuses(@CurrentPrincipal() p: AuthPrincipal) {
    return this.workspace.references("statuses", p);
  }
  @Get("references/persons")
  @ApiOperation({
    operationId: "searchCandidatePersons",
    summary:
      "Explicit ERP physical person selection, search requires 3 characters",
  })
  @ApiResponse({ status: 200, type: CandidateReferencesDto })
  persons(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query() q: CandidateReferenceQueryDto,
  ) {
    return this.workspace.references("persons", p, q.q);
  }
  @Post()
  @ApiOperation({
    operationId: "createCandidate",
    summary:
      "Create candidate in ERP with durable requestId, initial status Подбор",
  })
  @ApiResponse({ status: 201, type: CandidateWorkspaceDto })
  create(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body() body: CreateCandidateDto,
  ) {
    return this.workspace.create(p, body);
  }
  @Get(":candidateId/workspace")
  @ApiOperation({
    operationId: "getCandidateWorkspace",
    summary: "Confirmed ERP candidate card and status history",
  })
  @ApiResponse({ status: 200, type: CandidateWorkspaceDto })
  card(@Param("candidateId") id: string, @CurrentPrincipal() p: AuthPrincipal) {
    return this.workspace.card(id, p);
  }
  @Get(":candidateId/requirements")
  @ApiOperation({ operationId: "getCandidateRequirements", summary: "Applicable ERP document requirements for the confirmed current candidate profile" })
  @ApiResponse({ status: 200, type: CatalogDocumentTypesDto })
  requirements(@Param("candidateId") id: string, @CurrentPrincipal() p: AuthPrincipal) {
    return this.workspace.requirements(id, p);
  }
  @Patch(":candidateId/workspace")
  @ApiOperation({
    operationId: "updateCandidateWorkspace",
    summary: "Patch editable candidate fields through ERP business logic",
  })
  @ApiResponse({ status: 200, type: CandidateWorkspaceDto })
  update(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Body() body: UpdateCandidateDto,
  ) {
    return this.workspace.update(id, p, body);
  }
  @Post(":candidateId/status")
  @HttpCode(200)
  @ApiOperation({
    operationId: "changeCandidateStatus",
    summary: "ERP status transition and optional comment",
  })
  @ApiResponse({ status: 200, type: CandidateWorkspaceDto })
  status(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Body() body: CandidateStatusRequestDto,
  ) {
    return this.workspace.status(id, p, body);
  }
  @Post(":candidateId/person-link")
  @HttpCode(200)
  @ApiOperation({
    operationId: "linkCandidatePerson",
    summary:
      "Confirm existing physical person for current cycle, without employment admission",
  })
  @ApiResponse({ status: 200, type: CandidateWorkspaceDto })
  link(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Body() body: CandidatePersonLinkDto,
  ) {
    return this.workspace.link(id, p, body);
  }
  @Get(":candidateId/previous-documents")
  @ApiOperation({
    operationId: "listCandidatePreviousDocuments",
    summary:
      "All available linked ERP person documents, requiring cycle-specific recheck",
  })
  @ApiResponse({ status: 200, type: CandidatePreviousDocumentsDto })
  previous(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.workspace.previous(id, p);
  }
  @Patch(":candidateId/previous-documents/:documentId")
  @ApiOperation({
    operationId: "recheckCandidatePreviousDocument",
    summary:
      "Save review for current admission cycle without changing historical ERP decisions",
  })
  @ApiResponse({ status: 200, type: CandidatePreviousDocumentsDto })
  recheck(
    @Param("candidateId") id: string,
    @Param("documentId") documentId: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Body() body: CandidateRecheckRequestDto,
  ) {
    return this.workspace.recheck(id, documentId, p, body);
  }
  @Get(":candidateId/previous-documents/:documentId/original")
  @ApiOperation({
    operationId: "getCandidatePreviousDocumentOriginal",
    summary: "Authorized binary original from linked ERP physical person",
  })
  @ApiResponse({
    status: 200,
    description: "Original document bytes",
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  })
  async original(
    @Param("candidateId") id: string,
    @Param("documentId") documentId: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.workspace.original(id, documentId, p);
    return reply
      .header("Content-Type", file.mimeType)
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(file.bytes);
  }
}

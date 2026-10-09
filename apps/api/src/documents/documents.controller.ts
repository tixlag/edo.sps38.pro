import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { LkInternalGuard } from "./lk-internal.guard";
import { DocumentUploadService } from "./document-upload.service";
import { DocumentIngestionService } from "./document-ingestion.service";
import { DocumentReadService } from "./document-read.service";
import { DocumentReviewService } from "./document-review.service";
import {
  ApiErrorDto,
  CandidateDto,
  CandidateListDto,
  CandidateQueryDto,
  DocumentListDto,
  DocumentTypeListDto,
  DocumentVersionDto,
  DownloadDto,
  EditDocumentFieldsDto,
  EmployeeLinkDto,
  ReviewRevisionDto,
  UploadAcceptedDto,
} from "./dto/document.dto";

const Errors = () =>
  applyDecorators(
    ...[400, 401, 403, 404, 409, 413, 415, 500, 503].map((status) =>
      ApiResponse({ status, type: ApiErrorDto }),
    ),
  );
type Request = FastifyRequest & { correlationId?: string };

@ApiTags("candidate-integration")
@ApiBearerAuth("lk-service-token")
@Errors()
@Public()
@UseGuards(LkInternalGuard)
@Controller("internal/edo/v1/candidate-chats")
export class CandidateIntegrationController {
  constructor(
    private readonly uploads: DocumentUploadService,
    private readonly ingestion: DocumentIngestionService,
    private readonly reads: DocumentReadService,
  ) {}

  @Post(":chatUuid/documents")
  @HttpCode(202)
  @ApiOperation({
    summary: "Upload images/PDF of one candidate document for asynchronous OCR",
    operationId: "uploadCandidateDocument",
  })
  @ApiConsumes("multipart/form-data")
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "1–128 printable ASCII characters; identical retries return the same job",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["documentTypeCode", "files[]"],
      properties: {
        documentTypeCode: { type: "string", maxLength: 64 },
        locationId: { type: "integer", minimum: 1 },
        "files[]": {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", format: "binary" },
          description:
            "JPEG, PNG, WebP or PDF; mixed bundle allowed. File order is preserved.",
        },
      },
    },
  })
  @ApiResponse({ status: 202, type: UploadAcceptedDto })
  async upload(
    @Param("chatUuid", new ParseUUIDPipe()) chatUuid: string,
    @Req() req: Request,
  ): Promise<UploadAcceptedDto> {
    this.ingestion.ensureAvailable();
    const key = req.headers["idempotency-key"];
    const upload = await this.uploads.parse(req);
    try {
      return await this.ingestion.upload(
        chatUuid.toLowerCase(),
        typeof key === "string" ? key : undefined,
        upload,
        req.correlationId ?? "",
      );
    } finally {
      await this.uploads.dispose(upload);
    }
  }

  @Get(":chatUuid/documents/:documentId/versions/:version")
  @ApiOperation({
    summary: "Poll candidate document OCR/review result",
    operationId: "getCandidateDocumentResult",
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  result(
    @Param("chatUuid", new ParseUUIDPipe()) chatUuid: string,
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
  ): Promise<DocumentVersionDto> {
    return this.reads.internalVersion(chatUuid.toLowerCase(), id, version);
  }

  @Put(":chatUuid/employee-link")
  @ApiOperation({
    summary: "Explicitly link candidate chat to future/existing LK code1c",
    operationId: "linkCandidateEmployee",
  })
  @ApiResponse({ status: 200, type: CandidateDto })
  link(
    @Param("chatUuid", new ParseUUIDPipe()) chatUuid: string,
    @Body() body: EmployeeLinkDto,
    @Req() req: Request,
  ): Promise<CandidateDto> {
    return this.ingestion.link(
      chatUuid.toLowerCase(),
      body.code1c,
      req.correlationId ?? "",
    );
  }
}

@ApiTags("documents")
@ApiBearerAuth("access-jwt")
@Errors()
@Controller("v1")
export class DocumentsController {
  constructor(
    private readonly reads: DocumentReadService,
    private readonly review: DocumentReviewService,
  ) {}

  @Get("document-types")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    summary: "List supported document type codes",
    operationId: "listDocumentTypes",
  })
  @ApiResponse({ status: 200, type: DocumentTypeListDto })
  types(): Promise<DocumentTypeListDto> {
    return this.reads.types();
  }

  @Get("candidates")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    summary: "List candidate chats in allowed locations",
    operationId: "listCandidates",
  })
  @ApiResponse({ status: 200, type: CandidateListDto })
  candidates(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: CandidateQueryDto,
  ): Promise<CandidateListDto> {
    return this.reads.candidates(principal, query.limit, query.cursor);
  }

  @Get("candidates/:candidateId/documents")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    summary: "List candidate documents",
    operationId: "listCandidateDocuments",
  })
  @ApiResponse({ status: 200, type: DocumentListDto })
  candidateDocuments(
    @Param("candidateId") id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<DocumentListDto> {
    return this.reads.candidateDocuments(id, principal);
  }

  @Get("employees/:employeeId/documents")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    summary: "List employee and explicitly linked candidate documents",
    operationId: "listEmployeeDocuments",
  })
  @ApiResponse({ status: 200, type: DocumentListDto })
  employeeDocuments(
    @Param("employeeId") id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<DocumentListDto> {
    return this.reads.employeeDocuments(id, principal);
  }

  @Get("documents/:documentId/versions/:version")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    summary: "Get original OCR fields, corrections and processing issues",
    operationId: "getDocumentVersion",
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  version(
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<DocumentVersionDto> {
    return this.reads.publicVersion(id, version, principal);
  }

  @Get("documents/:documentId/versions/:version/files/:fileId/download")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    summary: "Get a private file download URL (expires in 5 minutes)",
    operationId: "getDocumentFileDownload",
  })
  @ApiResponse({ status: 200, type: DownloadDto })
  download(
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
    @Param("fileId") fileId: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<DownloadDto> {
    return this.reads.download(id, version, fileId, principal);
  }

  @Patch("documents/:documentId/versions/:version/fields")
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW)
  @ApiOperation({
    summary: "Correct current document fields with optimistic concurrency",
    operationId: "editDocumentFields",
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  edit(
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
    @Body() body: EditDocumentFieldsDto,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    return this.review.edit(
      id,
      version,
      body.revision,
      body.fields,
      principal,
      req.correlationId ?? "",
    );
  }

  @Post("documents/:documentId/versions/:version/approve")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW)
  @ApiOperation({
    summary: "Approve the current reviewed document (does not trigger hiring)",
    operationId: "approveDocument",
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  approve(
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
    @Body() body: ReviewRevisionDto,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    return this.review.approve(
      id,
      version,
      body.revision,
      principal,
      req.correlationId ?? "",
    );
  }
}

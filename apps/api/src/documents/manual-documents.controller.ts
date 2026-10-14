import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  Param,
  ParseIntPipe,
  HttpCode,
  UseGuards,
  Sse,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiHeader,
  ApiProduces,
} from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { LkInternalGuard } from "./lk-internal.guard";
import { DocumentUploadService } from "./document-upload.service";
import { ManualDocumentService } from "./manual-document.service";
import { DocumentReadService } from "./document-read.service";
import { DocumentReviewService } from "./document-review.service";
import { DocumentDeliveryService } from "./document-delivery.service";
import { DocumentCatalogService } from "./document-catalog.service";
import {
  DocumentEventsService,
  DocumentStreamGuard,
  type DocumentEventScope,
} from "./document-events.service";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import type { AuthPrincipal } from "../auth/auth-principal";
import {
  ApiErrorDto,
  CatalogQueryDto,
  CatalogDocumentTypesDto,
  DocumentScopeDto,
  UploadAcceptedDto,
  DocumentListDto,
  DocumentStreamGrantDto,
  DocumentUploadGrantDto,
  DocumentUploadGrantRequestDto,
  RejectDocumentDto,
  DocumentVersionDto,
  DocumentDto,
  ReviewDocumentsQueryDto,
  ReviewDocumentsDto,
} from "./dto/document.dto";
import { applyDecorators } from "@nestjs/common";
import {
  DocumentUploadGrantGuard,
  DocumentUploadGrantService,
  type DocumentUploadCapability,
} from "./document-upload-grant.service";

const Errors = () =>
  applyDecorators(
    ...[400, 401, 403, 404, 409, 413, 415, 500, 503].map((status) =>
      ApiResponse({ status, type: ApiErrorDto }),
    ),
  );
type Request = FastifyRequest & {
  correlationId?: string;
  documentScope?: DocumentEventScope;
  documentGrantExpiry?: Date;
  documentUploadCapability?: DocumentUploadCapability;
};
@ApiTags("candidate-documents")
@ApiBearerAuth("lk-service-token")
@Errors()
@Public()
@UseGuards(LkInternalGuard)
@Controller("internal/edo/v1")
export class ManualDocumentIntegrationController {
  constructor(
    private readonly uploads: DocumentUploadService,
    private readonly manual: ManualDocumentService,
    private readonly reads: DocumentReadService,
    private readonly catalog: DocumentCatalogService,
    private readonly events: DocumentEventsService,
    private readonly uploadGrants: DocumentUploadGrantService,
  ) {}
  @Get("document-catalog")
  @ApiOperation({
    operationId: "getCandidateDocumentCatalog",
    summary: "Applicable document forms from ERP",
  })
  @ApiResponse({ status: 200, type: CatalogDocumentTypesDto })
  catalogList(@Query() query: CatalogQueryDto) {
    return this.catalog.list(query.position_code_1c, query.citizenship);
  }
  @Post("documents")
  @HttpCode(202)
  @ApiOperation({
    operationId: "submitCandidateDocument",
    summary: "Submit a document for manual review without OCR",
  })
  @ApiConsumes("multipart/form-data")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({
    schema: {
      type: "object",
      required: ["metadata", "files[]"],
      properties: {
        metadata: {
          type: "string",
          description:
            "JSON: documentUid, chat_uuid and/or code_1c, position_code_1c, citizenship (default ru), documentFields, optional project_code_1c/locationId",
        },
        "files[]": {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", format: "binary" },
        },
      },
    },
  })
  @ApiResponse({ status: 202, type: UploadAcceptedDto })
  async upload(@Req() req: Request) {
    const upload = await this.uploads.parse(req);
    try {
      return await this.manual.upload(
        upload,
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
        req.correlationId ?? "",
      );
    } finally {
      await this.uploads.dispose(upload);
    }
  }
  @Get("documents")
  @ApiOperation({
    operationId: "getCandidateDocumentStatuses",
    summary: "Current document statuses of one owner",
  })
  @ApiResponse({ status: 200, type: DocumentListDto })
  statuses(@Query() scope: DocumentScopeDto) {
    return this.reads.internalDocuments(scope);
  }
  @Post("document-stream-grants")
  @HttpCode(200)
  @ApiOperation({
    operationId: "createDocumentStreamGrant",
    summary: "Mint a five-minute owner-scoped status stream grant",
  })
  @ApiResponse({ status: 200, type: DocumentStreamGrantDto })
  grant(@Body() scope: DocumentScopeDto) {
    return this.events.grant(scope);
  }
  @Post("document-upload-grants")
  @HttpCode(200)
  @ApiOperation({
    operationId: "createCandidateDocumentUploadGrant",
    summary:
      "Mint a five-minute upload grant bound to owner, document and bundle key",
  })
  @ApiResponse({ status: 200, type: DocumentUploadGrantDto })
  uploadGrant(@Body() scope: DocumentUploadGrantRequestDto) {
    return this.uploadGrants.grant(scope);
  }
}

@ApiTags("candidate-document-uploads")
@ApiBearerAuth("document-upload-token")
@Errors()
@Public()
@UseGuards(DocumentUploadGrantGuard)
@Controller("candidate-documents")
export class CandidateDocumentUploadController {
  constructor(
    private readonly uploads: DocumentUploadService,
    private readonly manual: ManualDocumentService,
  ) {}
  @Post()
  @HttpCode(202)
  @ApiOperation({
    operationId: "submitCandidateDocumentDirect",
    summary: "Upload files directly using a scoped upload grant",
  })
  @ApiConsumes("multipart/form-data")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({
    schema: {
      type: "object",
      required: ["metadata", "files[]"],
      properties: {
        metadata: {
          type: "string",
          description:
            "JSON with documentUid and documentFields only; owner and candidate context come from the upload grant",
        },
        "files[]": {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", format: "binary" },
        },
      },
    },
  })
  @ApiResponse({ status: 202, type: UploadAcceptedDto })
  async upload(@Req() req: Request) {
    const grant = req.documentUploadCapability!;
    const staged = await this.uploads.parse(req, grant.context);
    try {
      return await this.manual.upload(
        staged,
        grant.idempotencyKey,
        req.correlationId ?? "",
      );
    } finally {
      await this.uploads.dispose(staged);
    }
  }
}
@ApiTags("documents")
@ApiBearerAuth("access-jwt")
@Errors()
@Controller("v1")
export class ManualDocumentReviewController {
  constructor(
    private readonly reads: DocumentReadService,
    private readonly review: DocumentReviewService,
    private readonly delivery: DocumentDeliveryService,
    private readonly events: DocumentEventsService,
  ) {}
  @Get("review-documents")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "listReviewDocuments",
    summary: "Review queue or documents requiring ERP delivery",
  })
  @ApiResponse({ status: 200, type: ReviewDocumentsDto })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: ReviewDocumentsQueryDto,
  ) {
    return this.reads.reviewDocuments(
      principal,
      query.limit,
      query.cursor,
      query.status,
    );
  }
  @Get("documents/:documentId")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "getDocumentInfo",
    summary: "Document identity and current version",
  })
  @ApiResponse({ status: 200, type: DocumentDto })
  info(
    @Param("documentId") id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.reads.documentInfo(id, principal);
  }
  @Post("documents/:documentId/versions/:version/reject")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW)
  @ApiOperation({
    operationId: "rejectDocument",
    summary: "Return current document for a better photo",
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  reject(
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
    @Body() body: RejectDocumentDto,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() req: Request,
  ) {
    if (!body.reason.trim())
      throw new BadRequestException("Rejection reason is required");
    return this.review.reject(
      id,
      version,
      body.revision,
      body.reason.trim(),
      principal,
      req.correlationId ?? "",
    );
  }
  @Post("documents/:documentId/versions/:version/send-to-erp")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.INTEGRATIONS_MANAGE)
  @ApiOperation({
    operationId: "sendDocumentToErp",
    summary: "Manually send an approved document to ERP; no automatic retry",
  })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  send(
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.delivery.request(
      id,
      version,
      principal,
      req.correlationId ?? "",
    );
  }
  @Sse("document-status-events")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiProduces("text/event-stream")
  @ApiOperation({
    operationId: "streamReviewDocumentStatuses",
    summary: "Scoped document status snapshots over SSE",
  })
  @ApiResponse({ status: 200, type: DocumentListDto })
  stream(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.events.stream(undefined, principal);
  }
}
@ApiTags("candidate-documents")
@Errors()
@ApiBearerAuth("document-stream-token")
@Public()
@UseGuards(DocumentStreamGuard)
@Controller("document-status-events")
export class CandidateDocumentEventsController {
  constructor(private readonly events: DocumentEventsService) {}
  @Sse()
  @ApiProduces("text/event-stream")
  @ApiOperation({
    operationId: "streamCandidateDocumentStatuses",
    summary: "Read-only owner status stream using a short-lived grant",
  })
  @ApiResponse({ status: 200, type: DocumentListDto })
  stream(@Req() req: Request) {
    return this.events.stream(
      req.documentScope,
      undefined,
      req.documentGrantExpiry,
    );
  }
}

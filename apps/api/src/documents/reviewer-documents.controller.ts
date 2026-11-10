import { Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, Patch, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { ApiErrorDto, CatalogDocumentTypesDto, DocumentVersionDto, EditDocumentFieldsDto, UploadAcceptedDto } from "./dto/document.dto";
import { PreviousDocumentDetailsDto } from "./dto/reviewer-document.dto";
import { ReviewerDocumentsService } from "./reviewer-documents.service";
import { DocumentDeliveryService } from "./document-delivery.service";

@ApiTags("documents")
@ApiBearerAuth("access-jwt")
@RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW_RU, EdoAccessRule.DOCUMENT_REVIEW_IG)
@ApiResponse({ status: 400, type: ApiErrorDto })
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@ApiResponse({ status: 404, type: ApiErrorDto })
@ApiResponse({ status: 409, type: ApiErrorDto })
@ApiResponse({ status: 413, type: ApiErrorDto })
@ApiResponse({ status: 503, type: ApiErrorDto })
@Controller("v1/candidates/:candidateId")
export class ReviewerDocumentsController {
  constructor(private readonly documents: ReviewerDocumentsService, private readonly delivery: DocumentDeliveryService) {}
  @Get("document-types")
  @ApiOperation({ operationId: "listReviewerCandidateDocumentTypes", summary: "Applicable types for reviewer uploads" })
  @ApiResponse({ status: 200, type: CatalogDocumentTypesDto })
  types(@Param("candidateId") id: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.documents.types(id, principal); }

  @Post("documents")
  @HttpCode(202)
  @ApiOperation({ operationId: "uploadReviewerCandidateDocument", summary: "Upload a document as the verified reviewer for OCR and review" })
  @ApiConsumes("multipart/form-data")
  @ApiHeader({ name: "Idempotency-Key", required: false, description: "May also be supplied as the idempotencyKey multipart field" })
  @ApiBody({ schema: { type: "object", required: ["documentTypeCode", "files[]", "idempotencyKey"], properties: {
    idempotencyKey: { type: "string", minLength: 1, maxLength: 128 }, documentTypeCode: { type: "string" }, "files[]": { type: "array", minItems: 1, maxItems: 10, items: { type: "string", format: "binary" } },
  } } })
  @ApiResponse({ status: 202, type: UploadAcceptedDto })
  upload(@Param("candidateId") id: string, @CurrentPrincipal() principal: AuthPrincipal,
    @Req() req: any, @Headers("idempotency-key") key: string | undefined) {
    return this.documents.upload(id, principal, req, key, req.correlationId ?? "");
  }
  @Get("previous-documents/:documentId")
  @ApiOperation({ operationId: "getPreviousDocumentDetails", summary: "Original ERP requisites and local reviewer corrections" })
  @ApiResponse({ status: 200, type: PreviousDocumentDetailsDto })
  details(@Param("candidateId") id: string, @Param("documentId") documentId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.documents.details(id, documentId, principal);
  }
  @Patch("previous-documents/:documentId/fields")
  @ApiOperation({ operationId: "editPreviousDocumentFields", summary: "Save local-only corrections without modifying ERP" })
  @ApiResponse({ status: 200, type: PreviousDocumentDetailsDto })
  edit(@Param("candidateId") id: string, @Param("documentId") documentId: string, @Body() body: EditDocumentFieldsDto,
    @CurrentPrincipal() principal: AuthPrincipal, @Req() req: { correlationId?: string }) {
    return this.documents.edit(id, documentId, body, principal, req.correlationId ?? "");
  }
  @Post("documents/:documentId/versions/:version/delivery")
  @HttpCode(200)
  @ApiOperation({ operationId: "retryReviewerDocumentDelivery", summary: "Retry an approved reviewer upload using its existing ERP delivery key" })
  @ApiResponse({ status: 200, type: DocumentVersionDto })
  async retry(@Param("candidateId") id: string, @Param("documentId") documentId: string, @Param("version", ParseIntPipe) version: number,
    @CurrentPrincipal() principal: AuthPrincipal, @Req() req: { correlationId?: string }) {
    await this.documents.assertReviewerDelivery(id, documentId, version, principal);
    return this.delivery.request(documentId, version, principal, req.correlationId ?? "");
  }
}

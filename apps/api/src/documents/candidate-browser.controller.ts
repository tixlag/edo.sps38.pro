import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  ValidationPipe,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "../auth/public.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { CandidateDocumentsService } from "./candidate-documents.service";
import {
  CandidateDocumentContextDto,
  CandidateDocumentFormsDto,
  CandidateDocumentUploadRequestDto,
} from "./dto/candidate-context.dto";
import {
  CandidateDocumentDraftDto,
  CatalogDocumentTypesDto,
  DocumentListDto,
  DocumentStreamGrantDto,
  DocumentUploadGrantDto,
} from "./dto/document.dto";
import { CandidateDocumentErrorDto } from "./dto/candidate-error.dto";
const Errors = () =>
  applyDecorators(
    ...[400, 401, 403, 404, 409, 422, 500, 502, 503, 504].map((status) =>
      ApiResponse({ status, type: CandidateDocumentErrorDto }),
    ),
  );

/** The private chat-link capability is the existing guest candidate access model. */
@ApiTags("candidate-document-browser")
@Errors()
@Public()
@Controller("candidate-documents/by-chat/:chatUuid")
export class BrowserCandidateDocumentsController {
  constructor(private readonly documents: CandidateDocumentsService) {}
  @Get("context")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getCandidateDocumentContext",
    summary: "Candidate document context from LK identity and ERP",
  })
  @ApiResponse({ status: 200, type: CandidateDocumentContextDto })
  context(@Param("chatUuid", ParseUUIDPipe) uuid: string) {
    return this.documents.context(uuid.toLowerCase());
  }
  @Get("catalog")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getCandidateDocumentTypes",
    summary: "Applicable document forms for a verified candidate",
  })
  @ApiResponse({ status: 200, type: CatalogDocumentTypesDto })
  catalog(@Param("chatUuid", ParseUUIDPipe) uuid: string) {
    return this.documents.types(uuid.toLowerCase());
  }
  @Get("statuses")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getCandidateDocuments",
    summary: "Document statuses for a verified candidate chat",
  })
  @ApiResponse({ status: 200, type: DocumentListDto })
  statuses(@Param("chatUuid", ParseUUIDPipe) uuid: string) {
    return this.documents.statuses(uuid.toLowerCase());
  }
  @Get("documents/:documentUid/draft")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getBrowserCandidateDocumentDraft",
    summary: "Own current returned document fields",
  })
  @ApiResponse({ status: 200, type: CandidateDocumentDraftDto })
  draft(
    @Param("chatUuid", ParseUUIDPipe) uuid: string,
    @Param("documentUid", ParseUUIDPipe) uid: string,
  ) {
    return this.documents.draft(uuid.toLowerCase(), uid.toLowerCase());
  }
  @Post("stream-grant")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getCandidateDocumentsStreamGrant",
    summary: "Create a scoped document status stream grant",
  })
  @ApiResponse({ status: 200, type: DocumentStreamGrantDto })
  stream(@Param("chatUuid", ParseUUIDPipe) uuid: string) {
    return this.documents.streamGrant(uuid.toLowerCase());
  }
  @Post("upload-grant")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getCandidateDocumentUploadGrant",
    summary: "Create a scoped document upload grant using server context",
  })
  @ApiResponse({ status: 200, type: DocumentUploadGrantDto })
  @ApiBody({ type: CandidateDocumentUploadRequestDto })
  upload(
    @Param("chatUuid", ParseUUIDPipe) uuid: string,
    @Body(
      new ValidationPipe({
        expectedType: CandidateDocumentUploadRequestDto,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: unknown,
  ) {
    return this.documents.uploadGrant(
      uuid.toLowerCase(),
      body as CandidateDocumentUploadRequestDto,
    );
  }
}

@ApiTags("candidate-document-browser")
@ApiBearerAuth("access-jwt")
@Errors()
@Controller("candidate-documents/my")
export class MyCandidateDocumentsController {
  constructor(private readonly documents: CandidateDocumentsService) {}
  @Get("chat")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getMyCandidateDocumentContext",
    deprecated: true,
    summary: "Own candidate document context from the unified auth-service JWT",
  })
  @ApiResponse({ status: 200, type: CandidateDocumentContextDto })
  context(@CurrentPrincipal() me: AuthPrincipal) {
    return this.documents.ownContext(me.code1c);
  }
  @Get("forms")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getMyCandidateDocumentForms",
    summary: "Own document forms and verified candidate context",
  })
  @ApiResponse({ status: 200, type: CandidateDocumentFormsDto })
  forms(@CurrentPrincipal() me: AuthPrincipal) {
    return this.documents.ownForms(me.code1c);
  }
  @Get("statuses")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getMyCandidateDocuments",
    summary: "Own document statuses, independently of ERP",
  })
  @ApiResponse({ status: 200, type: DocumentListDto })
  statuses(@CurrentPrincipal() me: AuthPrincipal) {
    return this.documents.ownStatuses(me.code1c);
  }
  @Get("documents/:documentUid/draft")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getMyCandidateDocumentDraft",
    summary: "Own returned document fields",
  })
  @ApiResponse({ status: 200, type: CandidateDocumentDraftDto })
  draft(
    @CurrentPrincipal() me: AuthPrincipal,
    @Param("documentUid", ParseUUIDPipe) uid: string,
  ) {
    return this.documents.ownDraft(me.code1c, uid.toLowerCase());
  }
  @Post("stream-grant")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getMyCandidateDocumentsStreamGrant",
    summary: "Own document status stream grant",
  })
  @ApiResponse({ status: 200, type: DocumentStreamGrantDto })
  stream(@CurrentPrincipal() me: AuthPrincipal) {
    return this.documents.ownStreamGrant(me.code1c);
  }
  @Post("upload-grant")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getMyCandidateDocumentUploadGrant",
    summary: "Own document upload grant using server context",
  })
  @ApiResponse({ status: 200, type: DocumentUploadGrantDto })
  @ApiBody({ type: CandidateDocumentUploadRequestDto })
  upload(
    @CurrentPrincipal() me: AuthPrincipal,
    @Body(
      new ValidationPipe({
        expectedType: CandidateDocumentUploadRequestDto,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: unknown,
  ) {
    return this.documents.ownUploadGrant(
      me.code1c,
      body as CandidateDocumentUploadRequestDto,
    );
  }
}

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
  CandidateDocumentUploadRequestDto,
} from "./dto/candidate-context.dto";
import {
  ApiErrorDto,
  CandidateDocumentDraftDto,
  CatalogDocumentTypesDto,
  DocumentListDto,
  DocumentStreamGrantDto,
  DocumentUploadGrantDto,
} from "./dto/document.dto";
const Errors = () =>
  applyDecorators(
    ...[400, 401, 403, 404, 409, 503].map((status) =>
      ApiResponse({ status, type: ApiErrorDto }),
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
    summary: "Own candidate document context from the unified auth-service JWT",
  })
  @ApiResponse({ status: 200, type: CandidateDocumentContextDto })
  context(@CurrentPrincipal() me: AuthPrincipal) {
    return this.documents.ownContext(me.code1c);
  }
}

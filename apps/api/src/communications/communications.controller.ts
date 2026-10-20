import {
  applyDecorators,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { Public } from "../auth/public.decorator";
import { ApiErrorDto } from "../documents/dto/document.dto";
import { CandidateCatalogService } from "./candidate-catalog.service";
import { CommunicationsService } from "./communications.service";
import { CommunicationEventsService } from "./communication-events.service";
import {
  ChatAttachmentDto,
  ChatDownloadDto,
  ChatLinkDto,
  ChatStreamGrantDto,
  CommunicationCandidatesDto,
  CommunicationCandidatesQueryDto,
  CommunicationContextDto,
  CommunicationHistoryDto,
  CommunicationOperationDto,
  CommunicationQueryDto,
  SendCommunicationDto,
} from "./communications.dto";
const Errors = () =>
  applyDecorators(
    ...[400, 401, 403, 404, 409, 413, 415, 500, 503].map((status) =>
      ApiResponse({ status, type: ApiErrorDto }),
    ),
  );

@ApiTags("communications")
@ApiBearerAuth("access-jwt")
@Errors()
@Controller("v1/candidates")
export class CommunicationsController {
  constructor(
    private readonly catalog: CandidateCatalogService,
    private readonly chats: CommunicationsService,
    private readonly events: CommunicationEventsService,
  ) {}
  @Get("catalog")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "listCommunicationCandidates",
    summary:
      "All accessible candidates, including candidates without documents",
  })
  @ApiResponse({ status: 200, type: CommunicationCandidatesDto })
  list(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query() query: CommunicationCandidatesQueryDto,
  ) {
    return this.catalog.list(p, query);
  }

  @Get(":candidateId/communications")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "getCommunicationContext",
    summary: "Available channels, recipients and reply templates",
  })
  @ApiResponse({ status: 200, type: CommunicationContextDto })
  context(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.chats.context(id, p);
  }

  @Get(":candidateId/communications/messages")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "listCommunicationMessages",
    summary: "Combined candidate chat history with independent source cursors",
  })
  @ApiResponse({ status: 200, type: CommunicationHistoryDto })
  history(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Query() query: CommunicationQueryDto,
  ) {
    return this.chats.history(id, p, query.limit, query.cursor);
  }

  @Post(":candidateId/communications/messages")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW)
  @ApiOperation({
    operationId: "sendCommunicationMessage",
    summary: "Send a candidate message; requestId makes retries safe",
  })
  @ApiResponse({ status: 200, type: CommunicationOperationDto })
  send(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Body() body: SendCommunicationDto,
  ) {
    return this.chats.send(id, p, body);
  }

  @Get(":candidateId/communications/operations/:operationId")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "getCommunicationOperation",
    summary: "Read the current user’s send receipt",
  })
  @ApiResponse({ status: 200, type: CommunicationOperationDto })
  operation(
    @Param("candidateId") id: string,
    @Param("operationId", ParseUUIDPipe) operation: string,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.chats.operation(id, p, operation);
  }

  @Post(":candidateId/communications/attachments")
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW)
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiOperation({
    operationId: "uploadCommunicationAttachment",
    summary: "Stage one private chat attachment (up to 10 MB)",
  })
  @ApiResponse({ status: 201, type: ChatAttachmentDto })
  async upload(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: FastifyRequest,
  ) {
    // Consume the entire multipart request before writing S3 or DB state.
    let file: { filename: string; mimeType: string; bytes: Buffer } | undefined;
    for await (const part of req.parts({
      limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 0, parts: 1 },
    })) {
      if (part.type !== "file" || part.fieldname !== "file" || file)
        throw new BadRequestException("Ожидается один файл");
      const bytes = await part.toBuffer();
      if (part.file.truncated)
        throw new BadRequestException("Файл превышает 10 МБ");
      file = { filename: part.filename, mimeType: part.mimetype, bytes };
    }
    if (!file) throw new BadRequestException("Файл не выбран");
    return this.chats.upload(id, p, file);
  }

  @Get(":candidateId/communications/attachment-download")
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "getCommunicationAttachmentDownload",
    summary:
      "Authorize a signed source attachment locator and return a short-lived download",
  })
  @ApiResponse({ status: 200, type: ChatDownloadDto })
  download(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
    @Query("attachmentId") token: string,
  ) {
    if (typeof token !== "string") throw new BadRequestException();
    return this.chats.download(id, p, token);
  }

  @Post(":candidateId/communications/lk-link")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW)
  @ApiOperation({
    operationId: "createCommunicationLkLink",
    summary: "Get or create the candidate’s canonical LK chat link",
  })
  @ApiResponse({ status: 200, type: ChatLinkDto })
  link(@Param("candidateId") id: string, @CurrentPrincipal() p: AuthPrincipal) {
    return this.chats.link(id, p);
  }

  @Post(":candidateId/communications/stream-grant")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    operationId: "createCommunicationStreamGrant",
    summary:
      "Issue a five-minute candidate-scoped SSE grant, bounded by JWT expiry",
  })
  @ApiResponse({ status: 200, type: ChatStreamGrantDto })
  grant(
    @Param("candidateId") id: string,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.events.grant(id, p);
  }
}

@ApiTags("communications")
@Errors()
@Controller("v1")
export class CommunicationEventsController {
  constructor(private readonly events: CommunicationEventsService) {}
  @Public()
  @Sse("communication-events")
  @ApiOperation({
    operationId: "streamCommunicationEvents",
    summary: "Candidate changes using an Authorization bearer stream grant",
  })
  @ApiResponse({
    status: 200,
    description:
      "SSE changed/heartbeat/source-unavailable events; renew the grant after expiry",
  })
  stream(@Req() req: FastifyRequest) {
    return this.events.open(req.headers.authorization);
  }
}

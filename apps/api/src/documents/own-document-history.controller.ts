import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Res,
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
import { OwnDocumentHistoryService } from "./own-document-history.service";
import { OwnDocumentHistoryDto } from "./dto/own-document-history.dto";
import { CandidateDocumentErrorDto } from "./dto/candidate-error.dto";

@ApiTags("candidate-document-browser")
@ApiBearerAuth("access-jwt")
@ApiResponse({ status: 400, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 401, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 403, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 404, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 409, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 500, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 502, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 503, type: CandidateDocumentErrorDto })
@ApiResponse({ status: 504, type: CandidateDocumentErrorDto })
@Controller("candidate-documents/my/history")
export class OwnDocumentHistoryController {
  constructor(private readonly history: OwnDocumentHistoryService) {}
  private code(me: AuthPrincipal) {
    if (!me.code1c) throw new ForbiddenException("EMPLOYEE_IDENTITY_REQUIRED");
    return me.code1c;
  }
  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    operationId: "getMyDocumentHistory",
    summary: "Documents from previous employments",
  })
  @ApiResponse({ status: 200, type: OwnDocumentHistoryDto })
  list(@CurrentPrincipal() me: AuthPrincipal) {
    return this.history.list(this.code(me));
  }

  @Get("edo/:documentId/files/:fileId")
  @ApiOperation({
    operationId: "getMyHistoricalEdoFile",
    summary: "Download an owned historical EDO file",
  })
  @ApiResponse({
    status: 200,
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  })
  async edoFile(
    @CurrentPrincipal() me: AuthPrincipal,
    @Param("documentId") documentId: string,
    @Param("fileId") fileId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.history.edoFile(this.code(me), documentId, fileId);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Type", file.mimeType)
      .send(file.bytes);
  }

  @Get("erp/:documentId")
  @ApiOperation({
    operationId: "getMyHistoricalErpFile",
    summary: "Download an owned historical ERP original",
  })
  @ApiResponse({
    status: 200,
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  })
  async erpFile(
    @CurrentPrincipal() me: AuthPrincipal,
    @Param("documentId") documentId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.history.erpFile(this.code(me), documentId);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Type", file.mimeType)
      .send(file.bytes);
  }
}

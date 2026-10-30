import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  BadRequestException,
  PayloadTooLargeException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { ContractsService } from "./contracts.service";
import {
  ContractActionDto,
  ConfirmContractDto,
  ContractDetailDto,
  ContractErrorDto,
  ContractNotificationDto,
  ContractNotificationsDto,
  ContractsDto,
  ContractTypesDto,
  CreateContractDto,
  SigningCandidateDto,
} from "./contract.dto";

@ApiTags("signing-contracts")
@ApiBearerAuth("access-jwt")
@ApiResponse({ status: 400, type: ContractErrorDto })
@ApiResponse({ status: 401, type: ContractErrorDto })
@ApiResponse({ status: 403, type: ContractErrorDto })
@ApiResponse({ status: 404, type: ContractErrorDto })
@ApiResponse({ status: 409, type: ContractErrorDto })
@ApiResponse({ status: 413, type: ContractErrorDto })
@ApiResponse({ status: 422, type: ContractErrorDto })
@ApiResponse({ status: 500, type: ContractErrorDto })
@ApiResponse({ status: 502, type: ContractErrorDto })
@ApiResponse({ status: 503, type: ContractErrorDto })
@ApiResponse({ status: 504, type: ContractErrorDto })
@RequireAccessRule(EdoAccessRule.SIGNING)
@Controller("contracts")
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get("types")
  @ApiOperation({
    operationId: "listSigningDocumentTypes",
    summary: "Document types from ZUP",
  })
  @ApiResponse({ status: 200, type: ContractTypesDto })
  types() {
    return this.contracts.types();
  }

  @Get("candidates/:candidateId")
  @ApiOperation({
    operationId: "getSigningCandidate",
    summary: "Recipient context for a contract draft",
  })
  @ApiResponse({ status: 200, type: SigningCandidateDto })
  candidate(
    @Param("candidateId") id: string,
    @CurrentPrincipal() actor: AuthPrincipal,
  ) {
    return this.contracts.candidate(id, actor);
  }

  @Get("notifications")
  @ApiOperation({
    operationId: "listSigningNotifications",
    summary: "Own contract notifications",
  })
  @ApiResponse({ status: 200, type: ContractNotificationsDto })
  notifications(@CurrentPrincipal() actor: AuthPrincipal) {
    return this.contracts.notifications(actor);
  }

  @Post("notifications/:id/read")
  @ApiOperation({
    operationId: "readSigningNotification",
    summary: "Mark own notification read",
  })
  @ApiResponse({ status: 201, type: ContractNotificationDto })
  readNotification(
    @Param("id") id: string,
    @CurrentPrincipal() actor: AuthPrincipal,
  ) {
    return this.contracts.readNotification(id, actor);
  }

  @Get()
  @ApiOperation({
    operationId: "listSigningContracts",
    summary: "Contracts within recipient access scope",
  })
  @ApiQuery({ name: "candidateId", required: false, type: String })
  @ApiResponse({ status: 200, type: ContractsDto })
  list(
    @CurrentPrincipal() actor: AuthPrincipal,
    @Query("candidateId") candidateId?: string,
  ) {
    return this.contracts.list(actor, candidateId);
  }

  @Post()
  @ApiOperation({
    operationId: "createSigningContract",
    summary: "Generate PDF from ZUP or create a manual draft",
  })
  @ApiResponse({ status: 201, type: ContractDetailDto })
  create(
    @Body() body: CreateContractDto,
    @CurrentPrincipal() actor: AuthPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.contracts.create(body, actor, correlation(req));
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getSigningContract",
    summary: "Contract details and private file URLs",
  })
  @ApiResponse({ status: 200, type: ContractDetailDto })
  detail(@Param("id") id: string, @CurrentPrincipal() actor: AuthPrincipal) {
    return this.contracts.detail(id, actor);
  }

  @Post(":id/file")
  @ApiConsumes("multipart/form-data")
  @ApiOperation({
    operationId: "uploadSigningContractFile",
    summary: "Replace an unsent contract with PDF or DOCX",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "revision", "requestId"],
      properties: {
        file: { type: "string", format: "binary" },
        revision: { type: "integer", minimum: 0 },
        requestId: { type: "string", format: "uuid" },
      },
    },
  })
  @ApiResponse({ status: 201, type: ContractDetailDto })
  async upload(
    @Param("id") id: string,
    @CurrentPrincipal() actor: AuthPrincipal,
    @Req() req: FastifyRequest,
  ) {
    // Authorize before buffering any bytes. Per-route limits leave existing document upload policy intact.
    await this.contracts.detail(id, actor);
    let bytes: Buffer | undefined,
      filename = "";
    const fields: Record<string, unknown> = {};
    try {
      for await (const part of req.parts({
        limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 2, parts: 3 },
      })) {
        if (part.type === "file") {
          if (part.fieldname !== "file")
            throw new BadRequestException("Ожидается файл договора");
          bytes = await part.toBuffer();
          filename = part.filename;
        } else {
          if (
            !["revision", "requestId"].includes(part.fieldname) ||
            fields[part.fieldname] !== undefined
          )
            throw new BadRequestException("Некорректные поля загрузки");
          fields[part.fieldname] = part.value;
        }
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        code &&
        [
          "FST_REQ_FILE_TOO_LARGE",
          "FST_FILES_LIMIT",
          "FST_PARTS_LIMIT",
          "FST_FIELDS_LIMIT",
        ].includes(code)
      )
        throw new PayloadTooLargeException(
          "Загрузите один PDF или DOCX размером не более 50 МБ",
        );
      throw error;
    }
    const body = plainToInstance(ContractActionDto, {
      ...fields,
      revision:
        fields.revision === undefined ? undefined : Number(fields.revision),
    });
    if (!bytes || validateSync(body).length)
      throw new BadRequestException(
        "Укажите файл, ревизию и идентификатор запроса",
      );
    return this.contracts.upload(
      id,
      body,
      bytes,
      filename,
      actor,
      correlation(req),
    );
  }

  @Post(":id/send")
  @ApiOperation({
    operationId: "sendSigningContract",
    summary: "Simulate employer UKЕP confirmation and send immutable PDF",
  })
  @ApiResponse({ status: 201, type: ContractDetailDto })
  send(
    @Param("id") id: string,
    @Body() body: ContractActionDto,
    @CurrentPrincipal() actor: AuthPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.contracts.send(id, body, actor, correlation(req));
  }
}

@ApiTags("my-signing-contracts")
@ApiBearerAuth("access-jwt")
@ApiResponse({ status: 400, type: ContractErrorDto })
@ApiResponse({ status: 401, type: ContractErrorDto })
@ApiResponse({ status: 403, type: ContractErrorDto })
@ApiResponse({ status: 404, type: ContractErrorDto })
@ApiResponse({ status: 409, type: ContractErrorDto })
@ApiResponse({ status: 500, type: ContractErrorDto })
@ApiResponse({ status: 503, type: ContractErrorDto })
@Controller("my/contracts")
export class MyContractsController {
  constructor(private readonly contracts: ContractsService) {}
  @Get()
  @ApiOperation({
    operationId: "listMySigningContracts",
    summary: "Own received contracts from verified LK session",
  })
  @ApiResponse({ status: 200, type: ContractsDto })
  list(@CurrentPrincipal() actor: AuthPrincipal) {
    return this.contracts.listOwn(actor);
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getMySigningContract",
    summary: "Own contract and private files",
  })
  @ApiResponse({ status: 200, type: ContractDetailDto })
  detail(@Param("id") id: string, @CurrentPrincipal() actor: AuthPrincipal) {
    return this.contracts.detail(id, actor, true);
  }

  @Post(":id/confirm")
  @ApiOperation({
    operationId: "confirmMySigningContract",
    summary: "Simulate employee bank signing and archive confirmations",
  })
  @ApiResponse({ status: 201, type: ContractDetailDto })
  confirm(
    @Param("id") id: string,
    @Body() body: ConfirmContractDto,
    @CurrentPrincipal() actor: AuthPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.contracts.confirm(id, body, actor, correlation(req));
  }
  @Post(":id/decline")
  @ApiOperation({
    operationId: "declineMySigningContract",
    summary: "Decline an own pending contract",
  })
  @ApiResponse({ status: 201, type: ContractDetailDto })
  decline(
    @Param("id") id: string,
    @Body() body: ContractActionDto,
    @CurrentPrincipal() actor: AuthPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.contracts.decline(id, body, actor, correlation(req));
  }
}
function correlation(req: FastifyRequest) {
  return (req as FastifyRequest & { correlationId?: string }).correlationId;
}

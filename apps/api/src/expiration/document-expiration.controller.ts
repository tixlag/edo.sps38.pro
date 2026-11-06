import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { DocumentExpirationService } from "./document-expiration.service";
import {
  ExpirationItemsQueryDto,
  ExpirationItemsResponseDto,
  ExpirationSummaryResponseDto,
} from "./dto/expiration-query.dto";

@ApiTags("expirations")
@ApiBearerAuth("access-jwt")
@Controller("v1/expirations")
export class DocumentExpirationController {
  constructor(private readonly expirationService: DocumentExpirationService) {}

  @Get("summary")
  @RequireAccessRule(
    EdoAccessRule.DOCUMENT_REVIEW_RU,
    EdoAccessRule.DOCUMENT_REVIEW_IG,
    EdoAccessRule.FULL_ACCESS,
  )
  @ApiOperation({
    operationId: "getExpirationsSummary",
    summary: "Получить сводку по истекающим срокам документов",
  })
  @ApiResponse({
    status: 200,
    description: "Сводка KPI по истекающим срокам",
    type: ExpirationSummaryResponseDto,
  })
  async getSummary(
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<ExpirationSummaryResponseDto> {
    return this.expirationService.getSummary(principal);
  }

  @Get("items")
  @RequireAccessRule(
    EdoAccessRule.DOCUMENT_REVIEW_RU,
    EdoAccessRule.DOCUMENT_REVIEW_IG,
    EdoAccessRule.FULL_ACCESS,
  )
  @ApiOperation({
    operationId: "getExpiringItems",
    summary: "Получить список документов с истекающим сроком действия",
  })
  @ApiResponse({
    status: 200,
    description: "Список документов с истекающим сроком действия",
    type: ExpirationItemsResponseDto,
  })
  async getItems(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: ExpirationItemsQueryDto,
  ): Promise<ExpirationItemsResponseDto> {
    return this.expirationService.getItems(principal, query);
  }
}

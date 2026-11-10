import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { ApiErrorDto } from "./dto/document.dto";
import { IgEnrichmentQueueService } from "./ig-enrichment-queue.service";
import { CandidateEnrichmentDto } from "./dto/candidate-enrichment.dto";

@ApiTags("documents")
@ApiBearerAuth("access-jwt")
@ApiResponse({ status: 400, type: ApiErrorDto })
@ApiResponse({ status: 401, type: ApiErrorDto })
@ApiResponse({ status: 403, type: ApiErrorDto })
@ApiResponse({ status: 404, type: ApiErrorDto })
@ApiResponse({ status: 409, type: ApiErrorDto })
@ApiResponse({ status: 503, type: ApiErrorDto })
@Controller("v1/candidates")
export class CandidateEnrichmentController {
  constructor(private readonly queue: IgEnrichmentQueueService) {}
  @Post(":candidateId/enrichment")
  @HttpCode(202)
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW_IG)
  @ApiOperation({
    operationId: "requestCandidateEnrichment",
    summary: "Prioritize loading the IG employee profile and document history",
  })
  @ApiResponse({ status: 202, type: CandidateEnrichmentDto })
  request(
    @Param("candidateId") id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.queue.request(id, principal);
  }
}

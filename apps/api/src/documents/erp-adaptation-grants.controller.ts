import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "../auth/public.decorator";
import { ErpAdaptationGuard, ADAPTATION_ACCESS_TOKEN_HEADER } from "./erp-adaptation.guard";
import { IgEmploymentService } from "./ig-employment.service";
import { CandidatePreviousDocumentsSyncService } from "./candidate-previous-documents-sync.service";
import {
  AdaptationGrantsDto,
  AdaptationGrantsResultDto,
} from "./erp-adaptation-grants.dto";

@ApiTags("ERP Integration")
@ApiBearerAuth("lk-service-token")
@ApiHeader({
  name: ADAPTATION_ACCESS_TOKEN_HEADER,
  description: "Секрет adaptation из 1С HTTP_OUT_TOKEN_06",
  required: false,
})
@Public()
@UseGuards(ErpAdaptationGuard)
@Controller("internal/erp/v1/adaptation-grants")
export class ErpAdaptationGrantsController {
  private readonly logger = new Logger(ErpAdaptationGrantsController.name);

  constructor(
    private readonly employment: IgEmploymentService,
    @Optional()
    private readonly previousDocsSync?: CandidatePreviousDocumentsSyncService,
  ) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "applyErpAdaptationGrants",
    summary:
      "Прямой прием выдачи доступа иностранным сотрудникам из 1С. Повтор безопасен",
  })
  @ApiResponse({
    status: 200,
    description: "Элементы обработаны",
    type: AdaptationGrantsResultDto,
  })
  @ApiResponse({ status: 400, description: "Некорректный запрос / DTO" })
  @ApiResponse({ status: 401, description: "Не авторизован (неверный токен)" })
  async apply(
    @Body() dto: AdaptationGrantsDto,
  ): Promise<AdaptationGrantsResultDto> {
    const results: AdaptationGrantsResultDto["items"] = [];

    for (const item of dto.items) {
      try {
        const grantResult = await this.employment.applyGrant({
          id: item.operationId,
          employeeCode1c: item.code1c,
          citizenship: item.citizenship,
          createdAt: new Date().toISOString(),
          personUid: item.personUid,
          enabled: item.enabled,
        });

        if (grantResult.candidateId && this.previousDocsSync) {
          await this.previousDocsSync
            .syncPreviousDocuments(
              grantResult.candidateId,
              "system:adaptation",
              item.operationId,
            )
            .catch((err) =>
              this.logger.warn(
                `Previous documents sync failed for candidate ${grantResult.candidateId}: ${err?.message ?? err}`,
              ),
            );
        }

        results.push({
          operationId: item.operationId,
          code1c: item.code1c,
          applied: true,
          known: grantResult.known,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to apply adaptation grant for ${item.code1c} (operationId=${item.operationId}): ${message}`,
        );
        results.push({
          operationId: item.operationId,
          code1c: item.code1c,
          applied: false,
          known: false,
          errorMessage: message,
        });
      }
    }

    return { items: results };
  }
}

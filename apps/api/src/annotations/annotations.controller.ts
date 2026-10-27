import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { ApiErrorDto } from "../documents/dto/document.dto";
import * as D from "./annotation.dto";
import { AnnotationService } from "./annotation.service";
import { AnnotationCatalogService } from "./annotation-catalog.service";
import { AnnotationSourceService } from "./annotation-source.service";
const Errors = () =>
  applyDecorators(
    ...[400, 401, 403, 404, 409, 413, 415, 500, 503].map((status) =>
      ApiResponse({ status, type: ApiErrorDto }),
    ),
  );
type Request = FastifyRequest & { correlationId?: string };
@ApiTags("annotations")
@ApiBearerAuth("access-jwt")
@Errors()
@RequireAccessRule(
  EdoAccessRule.DOCUMENT_REVIEW_RU,
  EdoAccessRule.DOCUMENT_REVIEW_IG,
)
@Controller("v1/annotations")
export class AnnotationsController {
  constructor(private readonly service: AnnotationService) {}
  @Get("preference")
  @ApiOperation({
    operationId: "getAnnotationPreference",
    summary: "Read annotation participation preference",
  })
  @ApiResponse({ status: 200, type: D.AnnotationPreferenceDto })
  preference(@CurrentPrincipal() p: AuthPrincipal) {
    return this.service.preference(p);
  }
  @Put("preference")
  @ApiOperation({
    operationId: "setAnnotationPreference",
    summary: "Choose annotation participation",
  })
  @ApiResponse({ status: 200, type: D.AnnotationPreferenceDto })
  setPreference(
    @Body() dto: D.AnnotationPreferenceDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.setPreference(dto.enabled, p, req.correlationId);
  }
  @Get()
  @ApiOperation({
    operationId: "listAnnotations",
    summary: "List annotation work for permitted document groups",
  })
  @ApiResponse({ status: 200, type: D.AnnotationListDto })
  list(
    @Query() query: D.AnnotationQueryDto,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.service.list(query, p);
  }
  @Post("claim")
  @HttpCode(200)
  @ApiOperation({
    operationId: "claimAnnotation",
    summary: "Atomically claim current document version annotation",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDto })
  claim(
    @Body() dto: D.ClaimAnnotationDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.claim(dto, p, req.correlationId);
  }
  @Put(":id")
  @ApiOperation({
    operationId: "saveAnnotation",
    summary: "Save revisioned literal line annotations",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDto })
  save(
    @Param("id") id: string,
    @Body() dto: D.SaveAnnotationDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.mutate(id, "save", dto.revision, p, {
      fields: dto.fields,
      sections: dto.sections,
      correlationId: req.correlationId,
    });
  }
  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    operationId: "submitAnnotation",
    summary: "Submit a complete immutable annotation revision",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDto })
  submit(
    @Param("id") id: string,
    @Body() dto: D.AnnotationRevisionDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.mutate(id, "submit", dto.revision, p, {
      correlationId: req.correlationId,
    });
  }
  @Post(":id/accept")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "acceptAnnotation",
    summary: "Accept immutable annotation snapshot",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDto })
  accept(
    @Param("id") id: string,
    @Body() dto: D.AnnotationRevisionDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.mutate(id, "accept", dto.revision, p, {
      correlationId: req.correlationId,
    });
  }
  @Post(":id/changes")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "requestAnnotationChanges",
    summary: "Return annotation to its author with a note",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDto })
  changes(
    @Param("id") id: string,
    @Body() dto: D.AnnotationChangesDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.mutate(id, "changes", dto.revision, p, {
      note: dto.note,
      correlationId: req.correlationId,
    });
  }
  @Post(":id/reassign")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "reassignAnnotation",
    summary: "Reassign annotation author preserving submitted history",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDto })
  reassign(
    @Param("id") id: string,
    @Body() dto: D.ReassignAnnotationDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.mutate(id, "reassign", dto.revision, p, {
      authorId: dto.authorId,
      correlationId: req.correlationId,
    });
  }
}
@ApiTags("annotations")
@ApiBearerAuth("access-jwt")
@Errors()
@RequireAccessRule(
  EdoAccessRule.DOCUMENT_REVIEW_RU,
  EdoAccessRule.DOCUMENT_REVIEW_IG,
)
@Controller("v1/documents/:documentId/versions/:version/annotation-sources")
export class AnnotationSourcesController {
  constructor(private readonly sources: AnnotationSourceService) {}
  @Get()
  @ApiOperation({
    operationId: "getAnnotationSources",
    summary: "Read server-authoritative canonical original page frames",
  })
  @ApiResponse({ status: 200, type: D.AnnotationSourceDto })
  async get(
    @Param("documentId") id: string,
    @Param("version", ParseIntPipe) version: number,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.sources.publicDto(
      await this.sources.manifest(id, version, p),
      p,
    );
  }
}
@ApiTags("annotation-catalogs")
@ApiBearerAuth("access-jwt")
@Errors()
@RequireAccessRule(
  EdoAccessRule.DOCUMENT_REVIEW_RU,
  EdoAccessRule.DOCUMENT_REVIEW_IG,
)
@Controller("v1/annotation-catalogs")
export class AnnotationCatalogsController {
  constructor(private readonly service: AnnotationCatalogService) {}
  @Get("document-types")
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "listAnnotationDocumentTypes",
    summary: "Типы документов для настройки разметки",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDocumentTypesDto })
  types(@CurrentPrincipal() p: AuthPrincipal) {
    return this.service.documentTypes(p);
  }
  @Post("document-types/refresh")
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "refreshAnnotationDocumentTypes",
    summary: "Обновить типы из 1С и подготовить базовые списки полей",
  })
  @ApiResponse({ status: 201, type: D.AnnotationDocumentTypesDto })
  refreshTypes(@CurrentPrincipal() p: AuthPrincipal) {
    return this.service.documentTypes(p, true);
  }
  @Post("bootstrap")
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "bootstrapAnnotationCatalogs",
    summary: "Подготовить опубликованные базовые списки полей",
  })
  @ApiResponse({ status: 201, type: D.AnnotationBootstrapDto })
  bootstrap(@CurrentPrincipal() p: AuthPrincipal) {
    return this.service.bootstrap(p);
  }
  @Get()
  @ApiOperation({
    operationId: "listAnnotationCatalogs",
    summary: "Read published field schemas and administrator drafts",
  })
  @ApiResponse({ status: 200, type: D.AnnotationCatalogListDto })
  list(
    @Query() query: D.AnnotationCatalogQueryDto,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.service.list(query, p);
  }
  @Get("defaults/:documentTypeCode")
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "getAnnotationCatalogDefaults",
    summary:
      "Suggest physical field definitions without copying business values",
  })
  @ApiResponse({ status: 200, type: D.AnnotationCatalogDefaultsDto })
  @ApiQuery({
    name: "profile",
    required: false,
    type: String,
    description: "Код варианта документа",
  })
  defaults(
    @Param("documentTypeCode") code: string,
    @Query("profile") profile: string | undefined,
    @CurrentPrincipal() p: AuthPrincipal,
  ) {
    return this.service.defaults(code, p, profile);
  }
  @Post()
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "createAnnotationCatalog",
    summary: "Create independent versioned field schema draft",
  })
  @ApiResponse({ status: 201, type: D.AnnotationCatalogDto })
  create(
    @Body() dto: D.CreateAnnotationCatalogDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.create(dto, p, req.correlationId);
  }
  @Put(":id")
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "updateAnnotationCatalog",
    summary: "Replace unpublished catalog draft fields",
  })
  @ApiResponse({ status: 200, type: D.AnnotationCatalogDto })
  async update(
    @Param("id") id: string,
    @Body() dto: D.UpdateAnnotationCatalogDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ): Promise<D.AnnotationCatalogDto> {
    return (await this.service.mutate(
      id,
      dto.revision,
      dto,
      false,
      false,
      p,
      req.correlationId,
    )) as D.AnnotationCatalogDto;
  }
  @Delete(":id")
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "deleteAnnotationCatalog",
    summary: "Delete unpublished catalog draft",
  })
  @ApiResponse({ status: 200, type: D.AnnotationDeletedDto })
  async remove(
    @Param("id") id: string,
    @Query("revision", ParseIntPipe) revision: number,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ): Promise<D.AnnotationDeletedDto> {
    return (await this.service.mutate(
      id,
      revision,
      undefined,
      false,
      true,
      p,
      req.correlationId,
    )) as D.AnnotationDeletedDto;
  }
  @Post(":id/publish")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "publishAnnotationCatalog",
    summary: "Explicitly publish an immutable catalog schema",
  })
  @ApiResponse({ status: 200, type: D.AnnotationCatalogDto })
  async publish(
    @Param("id") id: string,
    @Body() dto: D.AnnotationRevisionDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ): Promise<D.AnnotationCatalogDto> {
    return (await this.service.mutate(
      id,
      dto.revision,
      undefined,
      true,
      false,
      p,
      req.correlationId,
    )) as D.AnnotationCatalogDto;
  }
  @Get(":id/suggestions")
  @ApiOperation({
    operationId: "listAnnotationCatalogSuggestions",
    summary: "Read field suggestions for a published catalog",
  })
  @ApiResponse({ status: 200, type: D.AnnotationCatalogSuggestionListDto })
  suggestions(@Param("id") id: string, @CurrentPrincipal() p: AuthPrincipal) {
    return this.service.suggestions(id, p);
  }
  @Post(":id/suggestions")
  @ApiOperation({
    operationId: "suggestAnnotationCatalogField",
    summary: "Suggest a literal field for a future catalog version",
  })
  @ApiResponse({ status: 201, type: D.AnnotationCatalogSuggestionDto })
  suggest(
    @Param("id") id: string,
    @Body() dto: D.SuggestAnnotationCatalogFieldDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.suggest(id, dto.key, dto.label, p, req.correlationId);
  }
  @Post(":id/suggestions/:suggestionId/resolve")
  @HttpCode(200)
  @RequireAccessRule(EdoAccessRule.FULL_ACCESS)
  @ApiOperation({
    operationId: "resolveAnnotationCatalogSuggestion",
    summary:
      "Resolve catalog field suggestion without changing published schemas",
  })
  @ApiResponse({ status: 200, type: D.AnnotationCatalogSuggestionDto })
  resolve(
    @Param("id") id: string,
    @Param("suggestionId") suggestionId: string,
    @Body() dto: D.ResolveAnnotationCatalogSuggestionDto,
    @CurrentPrincipal() p: AuthPrincipal,
    @Req() req: Request,
  ) {
    return this.service.resolve(
      id,
      suggestionId,
      dto.status,
      p,
      req.correlationId,
    );
  }
}

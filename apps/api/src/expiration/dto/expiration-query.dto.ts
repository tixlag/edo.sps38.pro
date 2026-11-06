import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export class ExpirationSummaryResponseDto {
  @ApiProperty({ description: "Общее число документов с истекающим сроком" })
  totalExpiring!: number;

  @ApiProperty({ description: "Истекают в пределах 30 дней (предупреждение)" })
  warning30d!: number;

  @ApiProperty({ description: "Истекают в пределах 15 дней (внимание)" })
  urgent15d!: number;

  @ApiProperty({ description: "Истекают в пределах 7 дней (критично)" })
  critical7d!: number;

  @ApiProperty({ description: "Истекают в пределах 1 дня (экстренно)" })
  emergency1d!: number;

  @ApiProperty({ description: "Срок действия уже истёк" })
  expired!: number;
}

export class ExpirationItemDto {
  @ApiProperty({ description: "Уникальный составной идентификатор элемента" })
  id!: string;

  @ApiProperty({ enum: ["DOCUMENT", "PREVIOUS_DOCUMENT"], description: "Тип источника" })
  sourceType!: "DOCUMENT" | "PREVIOUS_DOCUMENT";

  @ApiProperty({ description: "ID документа или предыдущего документа" })
  documentId!: string;

  @ApiProperty({ description: "Название документа" })
  documentTitle!: string;

  @ApiProperty({ type: String, nullable: true, description: "ID кандидата" })
  candidateId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "ФИО кандидата" })
  candidateName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Код 1C кандидата" })
  candidateCode1c!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Код 1C руководителя/менеджера" })
  managerCode1c!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "ФИО руководителя/менеджера" })
  managerName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Группа проверки (RU / IG)" })
  reviewGroup!: string | null;

  @ApiProperty({ description: "Дата окончания срока (YYYY-MM-DD)" })
  expiresAt!: string;

  @ApiProperty({ description: "Осталось дней (отрицательное число = просрочен)" })
  daysRemaining!: number;

  @ApiProperty({
    enum: ["NORMAL", "WARNING", "URGENT", "CRITICAL", "EMERGENCY", "EXPIRED"],
    description: "Уровень критичности",
  })
  severity!: "NORMAL" | "WARNING" | "URGENT" | "CRITICAL" | "EMERGENCY" | "EXPIRED";

  @ApiProperty({ type: Number, nullable: true, description: "Сработавший порог алерта в днях (30, 15, 7, 1, 0)" })
  thresholdDays!: number | null;
}

export class ExpirationItemsResponseDto {
  @ApiProperty({ type: [ExpirationItemDto], description: "Список документов с истекающим сроком" })
  items!: ExpirationItemDto[];

  @ApiProperty({ description: "Общее количество записей под фильтром" })
  total!: number;
}

export class ExpirationItemsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ enum: [30, 15, 7, 1, 0], description: "Фильтр по порогу (дней)" })
  @IsOptional()
  @Type(() => Number)
  @IsIn([30, 15, 7, 1, 0])
  threshold?: 30 | 15 | 7 | 1 | 0;

  @ApiPropertyOptional({ enum: ["RU", "IG", "ALL"], description: "Фильтр по группе проверки" })
  @IsOptional()
  @IsIn(["RU", "IG", "ALL"])
  reviewGroup?: "RU" | "IG" | "ALL";

  @ApiPropertyOptional({ description: "Фильтр по коду 1C менеджера" })
  @IsOptional()
  @IsString()
  managerCode1c?: string;
}

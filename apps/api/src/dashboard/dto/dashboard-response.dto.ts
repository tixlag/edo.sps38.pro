import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DocumentStatus } from "@prisma/client";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class KpiDto {
  @ApiProperty({ example: "queue" })
  key!: string;

  @ApiProperty({ example: "Очередь проверки" })
  label!: string;

  @ApiProperty({ example: "11" })
  value!: string;

  @ApiProperty({ example: "документов ждут проверки" })
  hint!: string;

  @ApiProperty({ enum: ["review", "signing", "general"], example: "review" })
  group!: "review" | "signing" | "general";
}

export class WeeklyBarDto {
  @ApiProperty({ example: "Пн" })
  day!: string;

  @ApiProperty({ example: 4 })
  value!: number;
}

export class StageSliceDto {
  @ApiProperty({ example: "Оформлены" })
  label!: string;

  @ApiProperty({ example: 18 })
  value!: number;
}

export class ActivityItemDto {
  @ApiProperty({ example: "doc-check" })
  kind!: string;

  @ApiProperty({
    example: "Проверка документа — СНИЛС — Холов Джамшед Фирузович",
  })
  title!: string;

  @ApiProperty({ example: "2 мин назад" })
  time!: string;
}

export class BlockedItemDto {
  @ApiProperty({ type: String })
  employeeId!: string;
  @ApiProperty({ example: "Токтогулов Айбек Русланович" })
  fullName!: string;

  @ApiProperty({ example: "Проверка патента" })
  step!: string;
}

export class TaskItemDto {
  @ApiProperty({ example: "Проверить страховой полис ДМС — Назаров Фаррух" })
  title!: string;

  @ApiProperty({ example: "today" })
  due!: string;
}

export class DashboardManagerDto {
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) code1c!: string | null;
}
export class DashboardSectionDto {
  @ApiProperty({ enum: ["RU", "IG"], enumName: "ReviewGroup" }) reviewGroup!:
    | "RU"
    | "IG";
  @ApiProperty({ type: [KpiDto] }) kpis!: KpiDto[];
  @ApiProperty({ type: [WeeklyBarDto] }) weekly!: WeeklyBarDto[];
  @ApiProperty({ type: [StageSliceDto] }) stages!: StageSliceDto[];
}
export class DashboardAttentionDto {
  @ApiProperty() documentId!: string;
  @ApiProperty() candidateId!: string;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: DocumentStatus, enumName: "DocumentStatus" })
  status!: DocumentStatus;
  @ApiProperty({ enum: ["RU", "IG"], enumName: "ReviewGroup" }) reviewGroup!:
    | "RU"
    | "IG";
}
export class DashboardQueryDto {
  @ApiPropertyOptional({
    enum: ["RU", "IG", "ALL"],
    description: "Default: all permitted review groups",
  })
  @IsOptional()
  @IsIn(["RU", "IG", "ALL"])
  reviewGroup?: "RU" | "IG" | "ALL";
  @ApiPropertyOptional({ description: "Exact manager code" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerCode1c?: string;
  @ApiPropertyOptional({
    description:
      "Exact legacy manager name, only candidates without manager code",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  managerName?: string;
  @ApiPropertyOptional({
    description: "Candidates without manager code or name",
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  managerUnassigned?: boolean;
}

export class DashboardResponseDto {
  @ApiProperty({ type: [DashboardManagerDto] })
  managers!: DashboardManagerDto[];
  @ApiProperty({ type: [DashboardSectionDto] })
  sections!: DashboardSectionDto[];
  @ApiProperty({ type: [DashboardAttentionDto] })
  attention!: DashboardAttentionDto[];
  @ApiProperty({ type: [KpiDto] })
  kpis!: KpiDto[];

  @ApiProperty({ type: [WeeklyBarDto] })
  weekly!: WeeklyBarDto[];

  @ApiProperty({ type: [StageSliceDto] })
  stages!: StageSliceDto[];

  @ApiProperty({ type: [ActivityItemDto] })
  activity!: ActivityItemDto[];

  @ApiProperty({ type: [BlockedItemDto] })
  blocked!: BlockedItemDto[];

  @ApiProperty({ type: [TaskItemDto] })
  tasks!: TaskItemDto[];

  @ApiProperty({ example: "database" })
  source!: string;
}

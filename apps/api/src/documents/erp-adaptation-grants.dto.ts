import { ApiProperty } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class AdaptationGrantItemDto {
  @ApiProperty({
    description: "UUID операции для подтверждения и идемпотентности",
    format: "uuid",
    example: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
  })
  @IsUUID()
  operationId!: string;

  @ApiProperty({
    description: "Код 1С сотрудника",
    example: "УП00035198",
    maxLength: 64,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code1c!: string;

  @ApiProperty({
    description: "UUID физлица в 1С",
    format: "uuid",
    example: "00000000-0000-4000-8000-000000000001",
  })
  @IsUUID()
  personUid!: string;

  @ApiProperty({
    description: "Код гражданства сотрудника (ИГ)",
    example: "UZ",
    maxLength: 16,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  citizenship!: string;

  @ApiProperty({
    description: "true — доступ открыт, false — доступ закрыт",
    example: true,
  })
  @IsBoolean()
  enabled!: boolean;
}

export class AdaptationGrantsDto {
  @ApiProperty({
    type: [AdaptationGrantItemDto],
    description: "Пакет операций выдачи доступа",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AdaptationGrantItemDto)
  items!: AdaptationGrantItemDto[];
}

export class AdaptationGrantResultItemDto {
  @ApiProperty({
    description: "UUID операции",
    format: "uuid",
    example: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
  })
  operationId!: string;

  @ApiProperty({
    description: "Код 1С сотрудника",
    example: "УП00035198",
  })
  code1c!: string;

  @ApiProperty({
    description: "Применен ли допуск в ЭДО",
    example: true,
  })
  applied!: boolean;

  @ApiProperty({
    description: "Известен ли кандидат системе",
    example: true,
  })
  known!: boolean;
}

export class AdaptationGrantsResultDto {
  @ApiProperty({
    type: [AdaptationGrantResultItemDto],
    description: "Результаты обработки элементов пакета",
  })
  items!: AdaptationGrantResultItemDto[];
}

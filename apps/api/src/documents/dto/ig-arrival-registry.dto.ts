import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type, Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export const DOCUMENT_STATUSES = [
  "UNKNOWN",
  "NO_DOCUMENTS",
  "IN_PROGRESS",
  "RETURNED",
  "APPROVED",
] as const;
export type RegistryDocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export class IgArrivalRegistryQueryDto {
  @ApiPropertyOptional({ enum: ["current", "archive"], default: "current" })
  @IsOptional()
  @IsIn(["current", "archive"])
  archive?: "current" | "archive";
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom?: string;
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo?: string;
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  locationUid?: string;
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  q?: string;
  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES })
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES)
  documentStatus?: RegistryDocumentStatus;
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  needsAttention?: boolean;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}
export class IgArrivalRegistryParticipationsQueryDto extends IgArrivalRegistryQueryDto {
  @ApiProperty({ maxLength: 256 })
  @IsString()
  @MaxLength(256)
  groupKey!: string;
}
export class IgArrivalRegistrySyncDto {
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  lastCompletedAt!: string | null;
}
export class IgArrivalRegistryGroupDto {
  @ApiProperty() groupKey!: string;
  @ApiProperty({ enum: ["assigned", "issues"] }) group!: "assigned" | "issues";
  @ApiProperty({ type: String, nullable: true, format: "date" }) arrivalDate!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) locationUid!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty() totalParticipationCount!: number;
  @ApiProperty() participationCount!: number;
  @ApiProperty() needsAttentionCount!: number;
}
export class IgArrivalRegistryParticipationDto {
  @ApiProperty({ type: String, nullable: true }) arrivalMemberUid!:
    | string
    | null;
  @ApiProperty() personUid!: string;
  @ApiProperty() code1c!: string;
  @ApiProperty({ type: String, nullable: true }) candidateId!: string | null;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "date" }) arrivalDate!:
    | string
    | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Local calendar time without UTC offset",
  })
  arrivalDateTime!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationUid!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty({ enum: ["CURRENT", "HISTORICAL", "CANCELLED", "ISSUE"] })
  participationStatus!: "CURRENT" | "HISTORICAL" | "CANCELLED" | "ISSUE";
  @ApiProperty({ enum: ["CURRENT", "NONE", "CONFLICT"] }) personState!:
    | "CURRENT"
    | "NONE"
    | "CONFLICT";
  @ApiProperty({ enum: DOCUMENT_STATUSES })
  documentStatus!: RegistryDocumentStatus;
  @ApiProperty() approvedDocuments!: number;
  @ApiProperty() confirmedDocuments!: number;
  @ApiProperty({
    enum: [
      "UNKNOWN",
      "NOT_REQUIRED",
      "PENDING",
      "NEEDS_ATTENTION",
      "CONFIRMED",
    ],
  })
  erpDeliveryStatus!:
    | "UNKNOWN"
    | "NOT_REQUIRED"
    | "PENDING"
    | "NEEDS_ATTENTION"
    | "CONFIRMED";
  @ApiProperty({ enum: ["UNKNOWN", "IN_PROGRESS", "DOCUMENTS_COMPLETED"] })
  employmentStatus!: "UNKNOWN" | "IN_PROGRESS" | "DOCUMENTS_COMPLETED";
  @ApiProperty({ enum: ["UNKNOWN"] }) oneCEmploymentStatus!: "UNKNOWN";
  @ApiProperty({ enum: ["CURRENT_CANDIDATE"] })
  statusScope!: "CURRENT_CANDIDATE";
  @ApiProperty() needsAttention!: boolean;
  @ApiProperty({ type: [String] }) issueCodes!: string[];
  @ApiProperty() sourceRevision!: string;
}
export class IgArrivalRegistryGroupsDto {
  @ApiProperty({ type: [IgArrivalRegistryGroupDto] })
  items!: IgArrivalRegistryGroupDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: IgArrivalRegistrySyncDto })
  sync!: IgArrivalRegistrySyncDto;
}
export class IgArrivalRegistryParticipationsDto {
  @ApiProperty({ type: [IgArrivalRegistryParticipationDto] })
  items!: IgArrivalRegistryParticipationDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: IgArrivalRegistrySyncDto })
  sync!: IgArrivalRegistrySyncDto;
}
export class IgArrivalRegistryLocationsQueryDto {
  @ApiPropertyOptional({ enum: ["current", "archive"], default: "current" })
  @IsOptional()
  @IsIn(["current", "archive"])
  archive?: "current" | "archive";
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  q?: string;
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  locationUid?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}
export class IgArrivalRegistryLocationDto {
  @ApiProperty({ format: "uuid" }) locationUid!: string;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
}
export class IgArrivalRegistryLocationsDto {
  @ApiProperty({ type: [IgArrivalRegistryLocationDto] })
  items!: IgArrivalRegistryLocationDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

import {
  ApiHideProperty,
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
} from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDefined,
  IsEmpty,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";

export class CandidateFieldsDto {
  @ApiHideProperty()
  @IsEmpty({ message: "Наставник назначается только в ERP" })
  mentor?: never;
  @ApiHideProperty()
  @IsEmpty({ message: "Наставник назначается только в ERP" })
  mentorId?: never;
  @ApiHideProperty() @IsEmpty() erpUid?: never;
  @ApiHideProperty() @IsEmpty() personUid?: never;
  @ApiHideProperty() @IsEmpty() chatUuid?: never;
  @ApiHideProperty() @IsEmpty() code1c?: never;
  @ApiProperty() @IsString() @Length(1, 512) fullName!: string;
  @ApiProperty() @IsString() @Length(5, 64) phone!: string;
  @ApiProperty({ format: "date" })
  @IsISO8601({ strict: true })
  birthDate!: string;
  @ApiProperty() @Matches(/^[a-zA-Z]{2}$/) citizenship!: string;
  @ApiProperty() @IsString() @Length(1, 64) positionCode!: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectCode?: string | null;
  @ApiProperty() @IsString() @Length(1, 64) managerId!: string;
}
export class CandidatePatchFieldsDto extends PartialType(CandidateFieldsDto) {}
export class CreateCandidateDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
  @ApiProperty({ type: CandidateFieldsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => CandidateFieldsDto)
  fields!: CandidateFieldsDto;
  @ApiPropertyOptional({
    description: "Opaque choice returned by searchCandidatePersons",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  personSelection?: string;
}
export class UpdateCandidateDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
  @ApiProperty({ type: CandidatePatchFieldsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => CandidatePatchFieldsDto)
  fields!: CandidatePatchFieldsDto;
}
export class CandidateStatusRequestDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
  @ApiProperty() @IsString() @Length(1, 128) statusId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  comment?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectCode?: string;
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @IsISO8601({ strict: true })
  plannedArrivalDate?: string;
}
export class CandidatePersonLinkDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  personSelection!: string;
}
export class CandidateReferenceQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(256) q?: string;
}
export class CandidateReferenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: "date" })
  birthDate?: string | null;
  @ApiPropertyOptional() editable?: boolean;
  @ApiPropertyOptional() requiresProject?: boolean;
  @ApiPropertyOptional() requiresPlannedArrivalDate?: boolean;
}
export class CandidateReferencesDto {
  @ApiProperty({ type: [CandidateReferenceDto] })
  items!: CandidateReferenceDto[];
}
export class CandidateNamedCodeDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
export class CandidateNamedIdDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}
export class CandidateMentorDto {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() position?: string;
}
export class CandidateStatusHistoryDto {
  @ApiProperty() date!: string;
  @ApiProperty() author!: string;
  @ApiProperty() statusId!: string;
  @ApiProperty() statusName!: string;
  @ApiProperty() comment!: string;
}
export class CandidateWorkspaceDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ["RU"] }) reviewGroup!: "RU";
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty({ format: "date" }) birthDate!: string;
  @ApiProperty() citizenship!: string;
  @ApiProperty({ type: CandidateNamedCodeDto, nullable: true })
  position!: CandidateNamedCodeDto | null;
  @ApiProperty({ type: CandidateNamedCodeDto, nullable: true })
  project!: CandidateNamedCodeDto | null;
  @ApiProperty({ type: CandidateNamedIdDto, nullable: true })
  manager!: CandidateNamedIdDto | null;
  @ApiProperty({ type: CandidateMentorDto, nullable: true })
  mentor!: CandidateMentorDto | null;
  @ApiProperty({ type: CandidateNamedIdDto }) status!: CandidateNamedIdDto;
  @ApiProperty() linkedPerson!: boolean;
  @ApiProperty() hasChat!: boolean;
  @ApiProperty({ type: [CandidateStatusHistoryDto] })
  history!: CandidateStatusHistoryDto[];
}
export const recheckStates = [
  "REQUIRES_REVIEW",
  "CONFIRMED",
  "REPLACE",
  "MISSING",
  "ORIGINAL_UNAVAILABLE",
] as const;
export class CandidatePreviousDocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) documentUid!: string | null;
  @ApiProperty({ type: "object", additionalProperties: true }) fields!: Record<
    string,
    unknown
  >;
  @ApiProperty({ type: String, nullable: true, format: "date" }) expiresAt!:
    | string
    | null;
  @ApiProperty() originalAvailable!: boolean;
  @ApiProperty({ enum: recheckStates, enumName: "CandidateRecheckStatus" })
  status!: (typeof recheckStates)[number];
  @ApiProperty({ type: String, nullable: true }) reviewedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) reviewedAt!: string | null;
}
export class CandidatePreviousDocumentsDto {
  @ApiProperty({ type: [CandidatePreviousDocumentDto] })
  items!: CandidatePreviousDocumentDto[];
}
export class CandidateRecheckRequestDto {
  @ApiProperty({ enum: recheckStates, enumName: "CandidateRecheckStatus" })
  @IsIn(recheckStates)
  status!: (typeof recheckStates)[number];
}

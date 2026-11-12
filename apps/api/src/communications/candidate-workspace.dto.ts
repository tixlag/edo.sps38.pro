import {
  ApiHideProperty,
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  OmitType,
} from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDefined,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  Min,
  Max,
  ValidateIf,
  IsEmpty,
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

export class CandidateResponsibleDto {
  @ApiProperty({ enum: ["user", "person"] }) @IsIn(["user", "person"]) kind!:
    | "user"
    | "person";
  @ApiProperty() @IsString() @Length(1, 64) id!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  name?: string;
}
export class CandidateSourceCommentDto {
  @ApiProperty({ enum: ["text", "person"] }) @IsIn(["text", "person"]) kind!:
    | "text"
    | "person";
  @ApiPropertyOptional()
  @ValidateIf((o) => o.kind === "text")
  @IsString()
  @MaxLength(200)
  text?: string;
  @ApiPropertyOptional()
  @ValidateIf((o) => o.kind === "person")
  @IsString()
  @Length(1, 64)
  id?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  name?: string;
}
export class CandidateContactDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) rowNumber?: number;
  @ApiProperty() @IsString() @Length(1, 128) typeId!: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  kindId?: string | null;
  @ApiProperty() @IsString() @MaxLength(200) presentation!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  comment?: string;
}
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
  @ApiProperty() @IsString() @Length(1, 50) fullName!: string;
  @ApiProperty() @IsString() @Length(5, 40) phone!: string;
  @ApiProperty({ format: "date" })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDate!: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Matches(/^[a-zA-Z]{2}$/)
  citizenship?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  positionCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  managerId?: string | null;
  @ApiPropertyOptional({ enum: ["male", "female"], nullable: true })
  @IsOptional()
  @IsIn(["male", "female"])
  sex?: "male" | "female" | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  settlement?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  expectedIncome?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  organizationId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sourceId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  universityId?: string | null;
  @ApiPropertyOptional({ type: CandidateResponsibleDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CandidateResponsibleDto)
  responsible?: CandidateResponsibleDto | null;
  @ApiPropertyOptional({ type: CandidateResponsibleDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CandidateResponsibleDto)
  additionalResponsible?: CandidateResponsibleDto | null;
  @ApiPropertyOptional({ type: CandidateSourceCommentDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CandidateSourceCommentDto)
  sourceComment?: CandidateSourceCommentDto | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  comment?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() gph?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() selfEmployed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() unofficial?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() apprentice?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() internship?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() targetedContract?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() contractTraining?: boolean;
  @ApiPropertyOptional({ type: String, format: "date", nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  internshipStartDate?: string | null;
  @ApiPropertyOptional({ type: String, format: "date", nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  internshipEndDate?: string | null;
  @ApiPropertyOptional({ type: [CandidateContactDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CandidateContactDto)
  contacts?: CandidateContactDto[];
}
export class CandidatePatchFieldsDto extends PartialType(
  OmitType(CandidateFieldsDto, ["birthDate"] as const),
) {
  @ApiPropertyOptional({ type: String, format: "date", nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDate?: string | null;
}
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
  @MaxLength(16384)
  personSelection?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(16384, { each: true })
  ignoredSelections?: string[];
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
  @MaxLength(16384)
  personSelection!: string;
}
export class CandidateReferenceQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(256) q?: string;
}
export class CandidatePersonMatchQueryDto {
  @ApiPropertyOptional({ enum: ["creation"] })
  @IsOptional()
  @IsIn(["creation"])
  scope?: "creation";
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 512)
  fullName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  middleName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  latinName?: string;
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDate?: string;
}
export class CandidateReferenceDto {
  @ApiPropertyOptional({
    format: "uuid",
    description:
      "Stable physical person identity for comparing choices; mutations require signed id",
  })
  personUid?: string;
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() code?: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: "date" })
  birthDate?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) latinName?:
    | string
    | null;
  @ApiPropertyOptional() matchedCyrillic?: boolean;
  @ApiPropertyOptional() matchedLatin?: boolean;
  @ApiPropertyOptional() matchedPhone?: boolean;
  @ApiPropertyOptional() matchedBirthDate?: boolean;
  @ApiPropertyOptional({ type: [String] }) candidateUids?: string[];
  @ApiPropertyOptional({ enum: ["user", "person"] }) kind?: "user" | "person";
  @ApiPropertyOptional() typeId?: string;
  @ApiPropertyOptional() editable?: boolean;
  @ApiPropertyOptional() requiresProject?: boolean;
  @ApiPropertyOptional() requiresPlannedArrivalDate?: boolean;
}
export class CandidateReferencesDto {
  @ApiProperty({ type: [CandidateReferenceDto] })
  items!: CandidateReferenceDto[];
}
export class CandidateMatchDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true, format: "date" }) birthDate!:
    | string
    | null;
  @ApiProperty() matchedName!: boolean;
  @ApiProperty() matchedPhone!: boolean;
  @ApiProperty() matchedBirthDate!: boolean;
  @ApiProperty() selection!: string;
}
export class CandidatePersonMatchesDto extends CandidateReferencesDto {
  @ApiProperty({ type: [CandidateMatchDto] }) candidates!: CandidateMatchDto[];
}
export class OpenExistingCandidateDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() erpUid!: string;
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
export class CandidatePersonDto extends CandidateNamedIdDto {
  @ApiProperty({ type: String, nullable: true, format: "date" }) birthDate!:
    | string
    | null;
  @ApiPropertyOptional() code?: string;
}
export class CandidateWorkspaceDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ["RU"] }) reviewGroup!: "RU";
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty({ type: String, nullable: true, format: "date" }) birthDate!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) citizenship!: string | null;
  @ApiProperty({ type: CandidateNamedCodeDto, nullable: true })
  position!: CandidateNamedCodeDto | null;
  @ApiProperty({ type: CandidateNamedCodeDto, nullable: true })
  project!: CandidateNamedCodeDto | null;
  @ApiProperty({ type: CandidateNamedIdDto, nullable: true })
  manager!: CandidateNamedIdDto | null;
  @ApiProperty({ type: CandidateMentorDto, nullable: true })
  mentor!: CandidateMentorDto | null;
  @ApiProperty({ type: CandidateNamedIdDto, nullable: true })
  status!: CandidateNamedIdDto | null;
  @ApiProperty({ type: CandidatePersonDto, nullable: true })
  person!: CandidatePersonDto | null;
  @ApiProperty({ enum: ["male", "female"], nullable: true }) sex!:
    | "male"
    | "female"
    | null;
  @ApiProperty({ type: String, nullable: true }) settlement!: string | null;
  @ApiProperty({ type: Number, nullable: true }) expectedIncome!: number | null;
  @ApiProperty({ type: CandidateNamedIdDto, nullable: true })
  organization!: CandidateNamedIdDto | null;
  @ApiProperty({ type: CandidateNamedIdDto, nullable: true })
  source!: CandidateNamedIdDto | null;
  @ApiProperty({ type: CandidateNamedIdDto, nullable: true })
  university!: CandidateNamedIdDto | null;
  @ApiProperty({ type: CandidateResponsibleDto, nullable: true })
  responsible!: CandidateResponsibleDto | null;
  @ApiProperty({ type: CandidateResponsibleDto, nullable: true })
  additionalResponsible!: CandidateResponsibleDto | null;
  @ApiProperty({ type: CandidateSourceCommentDto, nullable: true })
  sourceComment!: CandidateSourceCommentDto | null;
  @ApiProperty() comment!: string;
  @ApiProperty() gph!: boolean;
  @ApiProperty() selfEmployed!: boolean;
  @ApiProperty() unofficial!: boolean;
  @ApiProperty() apprentice!: boolean;
  @ApiProperty() internship!: boolean;
  @ApiProperty() targetedContract!: boolean;
  @ApiProperty() contractTraining!: boolean;
  @ApiProperty({ type: String, format: "date", nullable: true })
  internshipStartDate!: string | null;
  @ApiProperty({ type: String, format: "date", nullable: true })
  internshipEndDate!: string | null;
  @ApiProperty({ type: [CandidateContactDto] })
  contacts!: CandidateContactDto[];
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
export class CandidateEmploymentEventDto {
  @ApiProperty({ format: "date" }) eventDate!: string;
  @ApiProperty({ type: String, nullable: true, format: "date" }) startDate!:
    | string
    | null;
  @ApiProperty({ enum: ["HIRE", "DISMISSAL"] }) eventType!:
    | "HIRE"
    | "DISMISSAL";
}
export class CandidateEmploymentHistoryDto {
  @ApiProperty() available!: boolean;
  @ApiProperty({ type: [CandidateEmploymentEventDto] })
  items!: CandidateEmploymentEventDto[];
}
export class CandidateHistoricalEdoDocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() currentVersion!: number;
  @ApiProperty() status!: string;
}
export class CandidatePreviousDocumentsDto {
  @ApiProperty({ type: [CandidatePreviousDocumentDto] })
  items!: CandidatePreviousDocumentDto[];
  @ApiPropertyOptional({ type: CandidateEmploymentHistoryDto })
  employmentHistory?: CandidateEmploymentHistoryDto;
  @ApiPropertyOptional({ type: [CandidateHistoricalEdoDocumentDto] })
  edoDocuments?: CandidateHistoricalEdoDocumentDto[];
}

export class CandidateOperationDto {
  @ApiProperty({ enum: ["NOT_FOUND", "UNKNOWN", "SUCCEEDED", "REJECTED"] })
  state!: "NOT_FOUND" | "UNKNOWN" | "SUCCEEDED" | "REJECTED";
  @ApiPropertyOptional({ type: CandidateWorkspaceDto })
  candidate?: CandidateWorkspaceDto;
  @ApiPropertyOptional() code?: string;
}

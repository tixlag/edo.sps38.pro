import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
export enum AnnotationProfile {
  RU = "RU",
  UZ = "UZ",
  OTHER = "OTHER",
}
export enum AnnotationStatus {
  DRAFT = "DRAFT",
  SUBMITTED = "SUBMITTED",
  ACCEPTED = "ACCEPTED",
  CHANGES_REQUESTED = "CHANGES_REQUESTED",
}
export enum CatalogStatus {
  DRAFT = "DRAFT",
  PUBLISHED = "PUBLISHED",
}
export enum AnnotationDisposition {
  PRESENT = "PRESENT",
  NOT_PRESENT = "NOT_PRESENT",
  UNREADABLE = "UNREADABLE",
}
export enum AnnotationSourceKind {
  ORIGINAL = "ORIGINAL",
}
export enum SuggestionStatus {
  PENDING = "PENDING",
  APPLIED = "APPLIED",
  DISMISSED = "DISMISSED",
}
export class AnnotationCatalogFieldDto {
  @ApiProperty() @IsString() @Length(1, 64) key!: string;
  @ApiProperty() @IsString() @Length(1, 255) label!: string;
  @ApiProperty({ minimum: 0, type: Number }) @IsInt() @Min(0) ordinal!: number;
  @ApiProperty() @IsBoolean() multiline!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  businessFieldName?: string | null;
}
export class CreateAnnotationCatalogDto {
  @ApiProperty() @IsString() @Length(1, 64) documentTypeCode!: string;
  @ApiProperty({ enum: AnnotationProfile, enumName: "AnnotationProfile" })
  @IsEnum(AnnotationProfile)
  profile!: AnnotationProfile;
  @ApiProperty() @IsString() @Length(1, 255) title!: string;
  @ApiProperty({ type: [AnnotationCatalogFieldDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnnotationCatalogFieldDto)
  fields!: AnnotationCatalogFieldDto[];
}
export class AnnotationRevisionDto {
  @ApiProperty({ minimum: 0, type: Number }) @IsInt() @Min(0) revision!: number;
}
export class UpdateAnnotationCatalogDto extends AnnotationRevisionDto {
  @ApiProperty() @IsString() @Length(1, 255) title!: string;
  @ApiProperty({ type: [AnnotationCatalogFieldDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnnotationCatalogFieldDto)
  fields!: AnnotationCatalogFieldDto[];
}
export class AnnotationCatalogDto extends CreateAnnotationCatalogDto {
  @ApiProperty() id!: string;
  @ApiProperty() version!: number;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: CatalogStatus, enumName: "CatalogStatus" })
  status!: CatalogStatus;
}
export class AnnotationCatalogListDto {
  @ApiProperty({ type: [AnnotationCatalogDto] }) items!: AnnotationCatalogDto[];
}
export class AnnotationCatalogQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  documentTypeCode?: string;
  @ApiPropertyOptional({
    enum: AnnotationProfile,
    enumName: "AnnotationProfile",
  })
  @IsOptional()
  @IsEnum(AnnotationProfile)
  profile?: AnnotationProfile;
}
export class AnnotationPageDto {
  @ApiProperty() id!: string;
  @ApiProperty() fileId!: string;
  @ApiProperty({ minimum: 1 }) pageNumber!: number;
  @ApiProperty() sha256!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiProperty({ enum: [0, 90, 180, 270] }) rotation!: number;
  @ApiProperty({ enum: ["UPRIGHT_PIXELS_V1"] }) frame!: "UPRIGHT_PIXELS_V1";
  @ApiProperty() renderDpi!: number;
  @ApiProperty() mimeType!: string;
  @ApiProperty() previewUrl!: string;
}
export class AnnotationSourceDto {
  @ApiProperty() available!: boolean;
  @ApiProperty() documentId!: string;
  @ApiProperty() documentTypeCode!: string;
  @ApiProperty({ enum: AnnotationProfile, enumName: "AnnotationProfile" })
  profile!: AnnotationProfile;
  @ApiProperty() versionId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: AnnotationSourceKind, enumName: "AnnotationSourceKind" })
  sourceKind!: AnnotationSourceKind;
  @ApiProperty({ type: [AnnotationPageDto] }) pages!: AnnotationPageDto[];
}
export class AnnotationLineDto {
  @ApiProperty() @IsString() @Length(1, 64) id!: string;
  @ApiProperty() @IsString() @Length(1, 96) pageId!: string;
  @ApiProperty({ minimum: 0, type: Number })
  @IsInt()
  @Min(0)
  @Max(1000)
  order!: number;
  @ApiProperty({ maxLength: 2000 }) @IsString() @Length(0, 2000) text!: string;
  @ApiProperty({
    type: [Number],
    minItems: 8,
    maxItems: 8,
    description:
      "Clockwise oriented rectangle; x/y normalized to [0,1] in the upright page frame",
  })
  @IsArray()
  @ArrayMinSize(8)
  @ArrayMaxSize(8)
  quad!: number[];
}
export class AnnotationFieldAnswerDto {
  @ApiProperty() @IsString() @Length(1, 64) key!: string;
  @ApiProperty({
    enum: AnnotationDisposition,
    enumName: "AnnotationDisposition",
  })
  @IsEnum(AnnotationDisposition)
  disposition!: AnnotationDisposition;
  @ApiProperty({ type: [AnnotationLineDto] })
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => AnnotationLineDto)
  lines!: AnnotationLineDto[];
}
export class SaveAnnotationDto extends AnnotationRevisionDto {
  @ApiProperty({ type: [AnnotationFieldAnswerDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnnotationFieldAnswerDto)
  fields!: AnnotationFieldAnswerDto[];
}
export class ClaimAnnotationDto {
  @ApiProperty() @IsString() @Length(1, 64) documentId!: string;
  @ApiProperty({ minimum: 1, type: Number }) @IsInt() @Min(1) version!: number;
  @ApiProperty() @IsString() @Length(1, 64) catalogId!: string;
  @ApiPropertyOptional({
    enum: AnnotationSourceKind,
    enumName: "AnnotationSourceKind",
  })
  @IsOptional()
  @IsEnum(AnnotationSourceKind)
  sourceKind?: AnnotationSourceKind;
}
export class AnnotationDto {
  @ApiProperty() id!: string;
  @ApiProperty() documentId!: string;
  @ApiProperty() versionId!: string;
  @ApiProperty() catalogId!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: AnnotationStatus, enumName: "AnnotationStatus" })
  status!: AnnotationStatus;
  @ApiProperty({ enum: AnnotationSourceKind, enumName: "AnnotationSourceKind" })
  sourceKind!: AnnotationSourceKind;
  @ApiProperty({ type: AnnotationCatalogDto }) schema!: AnnotationCatalogDto;
  @ApiProperty({ type: AnnotationSourceDto }) sources!: AnnotationSourceDto;
  @ApiProperty({ type: [AnnotationFieldAnswerDto] })
  fields!: AnnotationFieldAnswerDto[];
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  submittedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  acceptedAt!: string | null;
  @ApiProperty() editable!: boolean;
}
export class AnnotationListDto {
  @ApiProperty({ type: [AnnotationDto] }) items!: AnnotationDto[];
}
export class AnnotationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() documentId?: string;
  @ApiPropertyOptional({ minimum: 1, type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
  @ApiPropertyOptional({ enum: AnnotationStatus, enumName: "AnnotationStatus" })
  @IsOptional()
  @IsEnum(AnnotationStatus)
  status?: AnnotationStatus;
}
export class AnnotationChangesDto extends AnnotationRevisionDto {
  @ApiProperty() @IsString() @Length(1, 2000) note!: string;
}
export class ReassignAnnotationDto extends AnnotationRevisionDto {
  @ApiProperty() @IsString() @Length(1, 64) authorId!: string;
}
export class AnnotationPreferenceDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
}
export class AnnotationDeletedDto {
  @ApiProperty() deleted!: boolean;
}
export class SuggestAnnotationCatalogFieldDto {
  @ApiProperty() @IsString() @Length(1, 64) key!: string;
  @ApiProperty() @IsString() @Length(1, 255) label!: string;
}
export class AnnotationCatalogSuggestionDto extends SuggestAnnotationCatalogFieldDto {
  @ApiProperty() id!: string;
  @ApiProperty() catalogId!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty({ enum: SuggestionStatus, enumName: "SuggestionStatus" })
  status!: SuggestionStatus;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
export class AnnotationCatalogSuggestionListDto {
  @ApiProperty({ type: [AnnotationCatalogSuggestionDto] })
  items!: AnnotationCatalogSuggestionDto[];
}
export class ResolveAnnotationCatalogSuggestionDto {
  @ApiProperty({ enum: [SuggestionStatus.APPLIED, SuggestionStatus.DISMISSED] })
  @IsEnum(SuggestionStatus)
  status!: SuggestionStatus;
}

export class AnnotationCatalogDefaultsDto {
  @ApiProperty({ type: [AnnotationCatalogFieldDto] })
  fields!: AnnotationCatalogFieldDto[];
}

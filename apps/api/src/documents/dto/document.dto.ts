import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DocumentStatus, OcrJobStatus } from "@prisma/client";
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  MinLength,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Transform, Type } from "class-transformer";

export class ApiErrorDto {
  @ApiProperty() statusCode!: number;
  @ApiProperty({
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  })
  message!: string | string[];
  @ApiProperty({ type: String, nullable: true }) correlationId!: string | null;
  @ApiProperty({ type: String, nullable: true }) path!: string | null;
}
export class CandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) chatUuid!:
    | string
    | null;
  @ApiProperty({ type: Number, nullable: true }) locationId!: number | null;
  @ApiProperty({ type: String, nullable: true }) code1c!: string | null;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
export class CandidateListDto {
  @ApiProperty({ type: [CandidateDto] }) items!: CandidateDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class CandidateQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}
export class ReviewGroupQueryDto {
  @ApiPropertyOptional({
    enum: ["RU", "IG"],
    enumName: "ReviewGroup",
    default: "RU",
  })
  @IsOptional()
  @IsIn(["RU", "IG"])
  reviewGroup?: "RU" | "IG";
}
export class DocumentFileDto {
  @ApiProperty() id!: string;
  @ApiProperty({
    description: "Zero-based position in the uploaded file bundle",
  })
  ordinal!: number;
  @ApiProperty() filename!: string;
  @ApiProperty({
    enum: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
      "application/octet-stream",
    ],
  })
  mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() pageCount!: number;
  @ApiProperty() deleted!: boolean;
}
export class OcrRegionDto {
  @ApiProperty() id!: string;
  @ApiProperty() fileId!: string;
  @ApiProperty({ minimum: 0 }) fileOrdinal!: number;
  @ApiProperty({ minimum: 1 }) pageNumber!: number;
  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description:
      "Normalized left coordinate after image EXIF/PDF page rotation",
  })
  x!: number;
  @ApiProperty({ minimum: 0, maximum: 1 }) y!: number;
  @ApiProperty({ exclusiveMinimum: true, minimum: 0, maximum: 1 })
  width!: number;
  @ApiProperty({ exclusiveMinimum: true, minimum: 0, maximum: 1 })
  height!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Original OCR text in this region, never changed by manual corrections",
  })
  text!: string | null;
}
export class DocumentFieldDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) originalValue!: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "Unformatted OCR field text for exact comparison; originalValue is the typed suggestion",
  })
  ocrText?: string | null;
  @ApiProperty({ type: String, nullable: true }) value!: string | null;
  @ApiProperty({ type: String, nullable: true }) editedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) submittedValue!: string | null;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ["text", "date", "boolean"] }) kind!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty() mismatch!: boolean;
  @ApiProperty({ type: [OcrRegionDto] }) regions!: OcrRegionDto[];
}
export class OcrIssueDto {
  @ApiProperty({ enum: ["DOCUMENT_TYPE_MISMATCH", "POOR_IMAGE_QUALITY"] })
  code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Zero-based source file position; null for bundle-level issues",
  })
  fileOrdinal!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "One-based page number within source file",
  })
  pageNumber!: number | null;
}
export class OcrJobDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: OcrJobStatus, enumName: "OcrJobStatus" })
  status!: OcrJobStatus;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty() cleanupPending!: boolean;
}
export class DocumentDeliveryAttemptDto {
  @ApiProperty() id!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ type: String, nullable: true }) finishedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "ERP HTTP response status; null when no response was received or for historical attempts",
  })
  httpStatus!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Bounded ERP response text with credentials and file contents redacted; historical responses are unavailable",
  })
  responseBody!: string | null;
  @ApiProperty({ description: "ERP response exceeded the capture limit" })
  responseTruncated!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "ERP_RESPONSE_READ_TIMEOUT or ERP_RESPONSE_READ_FAILED; does not override the received HTTP status",
  })
  responseReadError!: string | null;
}
export class DocumentDeliveryDto {
  @ApiProperty({
    enum: ["PENDING", "SENDING", "SENT", "REQUIRES_MANUAL", "WAITING_CONTRACT"],
  })
  status!: string;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: [DocumentDeliveryAttemptDto] })
  attempts!: DocumentDeliveryAttemptDto[];
}
export class DocumentOcrFieldDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) documentFieldName!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) value!: string | null;
  @ApiProperty({ enum: ["PADDLE", "GLM", "MIXED"] }) source!: string;
  @ApiProperty({ type: String, nullable: true }) paddleText!: string | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 1 })
  paddleConfidence!: number | null;
  @ApiPropertyOptional({ type: [OcrRegionDto] }) regions?: OcrRegionDto[];
}
export class DocumentOcrDetailsDto {
  @ApiProperty() revision!: number;
  @ApiProperty({ type: [DocumentOcrFieldDto] }) fields!: DocumentOcrFieldDto[];
  @ApiProperty({ type: "object", additionalProperties: true, nullable: true })
  raw!: unknown;
}
export class DocumentReviewMetadataDto {
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description:
      "Successful submission time, UTC ISO 8601; null when historically unknown",
  })
  submittedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description: "Approval or return decision time, UTC ISO 8601",
  })
  reviewedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Verified JWT UUID of the reviewer",
  })
  reviewedBy!: string | null;
}
export class DocumentVersionDto extends DocumentReviewMetadataDto {
  @ApiPropertyOptional({ enum: ["RU", "IG"], enumName: "ReviewGroup" })
  reviewGroup?: "RU" | "IG" | null;
  @ApiProperty({
    description:
      "Current supported submitted version has no OCR attempt and retained originals",
  })
  canStartOcr!: boolean;
  @ApiProperty({
    description:
      "Current supported version has a failed OCR attempt, retained originals, and enabled OCR",
  })
  canRetryOcr!: boolean;
  @ApiProperty() documentId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: DocumentStatus, enumName: "DocumentStatus" })
  status!: DocumentStatus;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: String, nullable: true, enum: ["STUB", "EXTERNAL"] })
  ocrSource!: string | null;
  @ApiProperty({ type: [DocumentFileDto] }) files!: DocumentFileDto[];
  @ApiProperty({ type: [DocumentFieldDto] }) fields!: DocumentFieldDto[];
  @ApiProperty({ type: [DocumentOcrFieldDto] })
  ocrFields!: DocumentOcrFieldDto[];
  @ApiProperty({ type: String, nullable: true }) reviewedByName!: string | null;
  @ApiProperty({ type: [OcrIssueDto] }) issues!: OcrIssueDto[];
  @ApiProperty({ type: OcrJobDto, nullable: true }) job!: OcrJobDto | null;
  @ApiProperty({ type: "object", additionalProperties: true, nullable: true })
  raw!: unknown;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  approvedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) approvedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) rejectionReason!:
    | string
    | null;
  @ApiProperty({ type: () => DocumentDeliveryDto, nullable: true })
  delivery!: DocumentDeliveryDto | null;
}
export class CandidateProfileDto {
  @ApiPropertyOptional({ type: String, nullable: true }) statusId?:
    | string
    | null;
  @ApiPropertyOptional({ type: String, nullable: true }) statusName?:
    | string
    | null;
  @ApiPropertyOptional({ type: String, nullable: true }) managerId?:
    | string
    | null;
  @ApiProperty({ enum: ["RU", "IG"], enumName: "ReviewGroup", nullable: true })
  reviewGroup!: "RU" | "IG" | null;
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) chatUuid!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) code1c!: string | null;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "date" }) birthDate!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) citizenship!: string | null;
  @ApiProperty({ type: String, nullable: true }) positionCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) positionName!: string | null;
  @ApiProperty({ type: String, nullable: true }) projectCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) projectName!: string | null;
  @ApiProperty({ type: String, nullable: true }) managerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) managerCode1c!: string | null;
  @ApiProperty({ type: String, nullable: true }) mentorName!: string | null;
  @ApiProperty({ type: String, nullable: true }) mentorPosition!: string | null;
  @ApiProperty({ type: String, nullable: true }) mentorCode1c!: string | null;
  @ApiProperty() isReemployment!: boolean;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  profileSyncedAt!: string | null;
  @ApiProperty({
    description:
      "Candidate APPROVED documents under the queue access scope (all tabs)",
  })
  approvedDocuments!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Applicable catalog document types for positionCode+citizenship; null when positionCode is unknown",
  })
  requiredDocuments!: number | null;
}
/** Returned versions retained after a newer document upload. */
export class ReturnedDocumentVersionDto extends DocumentReviewMetadataDto {
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, nullable: true }) rejectionReason!:
    | string
    | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      "Newer current version, or null while this returned version is still current",
  })
  supersededByVersion!: number | null;
}

/** Document properties shared by candidate details and document-oriented APIs. */
export class CandidateDocumentSummaryDto extends DocumentReviewMetadataDto {
  @ApiProperty({ enum: OcrJobStatus, enumName: "OcrJobStatus", nullable: true })
  ocrStatus!: OcrJobStatus | null;
  @ApiProperty({ type: String, nullable: true }) ocrErrorCode!: string | null;
  @ApiPropertyOptional({
    type: [ReturnedDocumentVersionDto],
    description:
      "Returned versions, newest first, including versions superseded by a new upload",
  })
  returnedVersions?: ReturnedDocumentVersionDto[];
  @ApiProperty({
    type: [Number],
    description: "Approved versions awaiting manual ERP delivery",
  })
  pendingDeliveryVersions!: number[];
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) documentTypeCode!:
    | string
    | null;
  @ApiProperty({ enum: DocumentStatus, enumName: "DocumentStatus" })
  status!: DocumentStatus;
  @ApiProperty() currentVersion!: number;
  @ApiProperty() revision!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) documentUid!: string | null;
  @ApiProperty({ type: String, nullable: true }) deliveryStatus!: string | null;
}
export class DocumentDto extends CandidateDocumentSummaryDto {
  @ApiProperty({ type: String, nullable: true }) candidateId!: string | null;
  @ApiProperty({ type: String, nullable: true }) chatUuid!: string | null;
  @ApiProperty({ type: String, nullable: true }) code1c!: string | null;
  @ApiProperty({
    type: () => CandidateProfileDto,
    nullable: true,
    description: "LK candidate profile snapshot, if one was provided",
  })
  candidate!: CandidateProfileDto | null;
}
export class DocumentListDto {
  @ApiProperty({ type: [DocumentDto] }) items!: DocumentDto[];
}
export class CandidateDetailsDto {
  @ApiProperty({ type: CandidateProfileDto }) candidate!: CandidateProfileDto;
  @ApiProperty({ type: [CandidateDocumentSummaryDto] })
  documents!: CandidateDocumentSummaryDto[];
}
export class CandidateReviewQueueDto {
  @ApiProperty({ type: [CandidateDetailsDto] }) items!: CandidateDetailsDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Last candidate id on this page; null when there is no next page",
  })
  nextCursor!: string | null;
}
export class DocumentTypeDto {
  @ApiProperty() code!: string;
  @ApiProperty() title!: string;
}
export class DocumentDefinitionDto {
  @ApiProperty() name!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ["text", "date", "boolean"] }) kind!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty() ordinal!: number;
}
export class CatalogDocumentTypeDto extends DocumentTypeDto {
  @ApiProperty({ format: "uuid" }) documentUid!: string;
  @ApiProperty({ type: [DocumentDefinitionDto] })
  fields!: DocumentDefinitionDto[];
}
export class CatalogDocumentTypesDto {
  @ApiProperty({ type: [CatalogDocumentTypeDto] })
  items!: CatalogDocumentTypeDto[];
}
export class DocumentTypeListDto {
  @ApiProperty({ type: [DocumentTypeDto] }) items!: DocumentTypeDto[];
}
export class DocumentTypesQueryDto {
  @ApiPropertyOptional({
    description:
      "Only ERP-catalog types (catalogSyncedAt != null), sorted by title",
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  catalogOnly?: boolean;
}
export class PositionDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
export class PositionListDto {
  @ApiProperty({ type: [PositionDto] }) items!: PositionDto[];
}
export class PositionQueryDto {
  @ApiPropertyOptional({ description: "Case-insensitive name search" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  q?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
export class FacetPersonDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) code1c!: string | null;
}
export class FacetProjectDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) code!: string | null;
}
export class ReviewDocumentFacetsDto {
  @ApiProperty({ type: [FacetPersonDto] }) managers!: FacetPersonDto[];
  @ApiProperty({ type: [FacetPersonDto] }) mentors!: FacetPersonDto[];
  @ApiProperty({ type: [FacetProjectDto] }) projects!: FacetProjectDto[];
  @ApiProperty({ type: [String] }) citizenships!: string[];
}
export class ReviewCandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
}
export class ReviewCandidateListDto {
  @ApiProperty({ type: [ReviewCandidateDto] }) items!: ReviewCandidateDto[];
}
export class ReviewCandidatesQueryDto extends ReviewGroupQueryDto {
  @ApiPropertyOptional({ description: "Case-insensitive fullName search" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  q?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
export class UploadAcceptedDto {
  @ApiProperty() candidateId!: string;
  @ApiProperty() documentId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, nullable: true }) jobId!: string | null;
  @ApiPropertyOptional() submissionId?: string;
  @ApiPropertyOptional({ enum: DocumentStatus }) status?: DocumentStatus;
}
export class EmployeeLinkDto {
  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  code1c!: string;
}
export class ReviewRevisionDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) revision!: number;
}
export class EditDocumentFieldsDto extends ReviewRevisionDto {
  @ApiProperty({
    type: "object",
    additionalProperties: {
      oneOf: [{ type: "string", nullable: true }, { type: "boolean" }],
    },
    description:
      "Field names mapped to new values; null clears a value. Maximum 200 fields, 16384 characters per value.",
  })
  @IsObject()
  fields!: Record<string, string | boolean | null>;
}
export class DownloadDto {
  @ApiProperty({ format: "uri" }) url!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
export class RejectDocumentDto extends ReviewRevisionDto {
  @ApiProperty({ maxLength: 1024, minLength: 1 })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  reason!: string;
}
export class DocumentScopeDto {
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  chat_uuid?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  code_1c?: string;
}
export class CatalogQueryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  position_code_1c!: string;
  @ApiPropertyOptional({ default: "ru" })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z]{2}$/)
  citizenship = "ru";
}
export class DocumentStreamGrantDto {
  @ApiProperty() token!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
export class CandidateSnapshotPositionDto {
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  name?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  code?: string;
}
export class CandidateSnapshotMentorDto {
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  name?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  position?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code1C?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code1c?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code_1c?: string;
}
export class CandidateSnapshotDto {
  @ApiPropertyOptional({ enum: ["RU", "IG"] })
  @IsOptional()
  @IsIn(["RU", "IG"])
  reviewGroup?: "RU" | "IG" | null;
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  personUid?: string;
  @ApiPropertyOptional({
    format: "uuid",
    description: "ERP candidate identifier supplied by the trusted ERP service",
  })
  @IsOptional()
  @IsUUID()
  erpUid?: string;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    nullable: true,
    description: "Chat UUID, named uuid by 1C",
  })
  @IsOptional()
  @IsUUID()
  uuid?: string | null;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fullName?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  name?: string;
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDate?: string;
  @ApiPropertyOptional({ maxLength: 2 })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z]{2}$/)
  citizenship?: string;
  @ApiPropertyOptional({ type: () => CandidateSnapshotPositionDto })
  @IsOptional()
  position?: CandidateSnapshotPositionDto | string;
  @ApiPropertyOptional({ type: () => CandidateSnapshotPositionDto })
  @IsOptional()
  project?: CandidateSnapshotPositionDto | string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  positionCode?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  positionName?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectCode?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  projectName?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  managerName?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  manager?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerCode1C?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerCode1c?: string;
  @ApiPropertyOptional({ type: () => CandidateSnapshotMentorDto })
  @IsOptional()
  mentor?: CandidateSnapshotMentorDto | string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  mentorName?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  mentorPosition?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  mentorCode1c?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isReemployment?: boolean;
}

export class DocumentUploadGrantRequestDto extends DocumentScopeDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() documentUid!: string;
  @ApiProperty({ maxLength: 128 })
  @IsString()
  @MaxLength(128)
  @Matches(/^[\x21-\x7e]{1,128}$/)
  idempotencyKey!: string;
  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  position_code_1c!: string;
  @ApiPropertyOptional({ default: "ru" })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z]{2}$/)
  citizenship = "ru";
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  project_code_1c?: string;
  @ApiPropertyOptional({
    type: () => CandidateSnapshotDto,
    description:
      "Optional LK candidate profile stored on the candidate and shown in the review queue",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CandidateSnapshotDto)
  candidateSnapshot?: CandidateSnapshotDto;
  @ApiPropertyOptional({
    type: () => CandidateSnapshotDto,
    description: "Legacy alias of candidateSnapshot",
    deprecated: true,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CandidateSnapshotDto)
  candidate_profile?: CandidateSnapshotDto;
}
export class DocumentUploadGrantDto {
  @ApiProperty({
    description: "Five-minute upload capability; keep in memory only",
  })
  token!: string;
  @ApiProperty({ format: "uri" }) url!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}
export class ReviewDocumentsQueryDto extends CandidateQueryDto {
  @ApiPropertyOptional({
    enum: ["RU", "IG"],
    enumName: "ReviewGroup",
    default: "RU",
  })
  @IsOptional()
  @IsIn(["RU", "IG"])
  reviewGroup?: "RU" | "IG";
  @ApiPropertyOptional({
    enum: ["IN_REVIEW", "ERP_PENDING", "RETURNED", "ALL"],
  })
  @IsOptional()
  @IsIn(["IN_REVIEW", "ERP_PENDING", "RETURNED", "ALL"])
  status?: string;
  @ApiPropertyOptional({ description: "Case-insensitive fullName search" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  q?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  documentTypeCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z]{2}$/)
  citizenship?: string;
  @ApiPropertyOptional({ description: "Manager name or code contains" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  manager?: string;
  @ApiPropertyOptional({ description: "Mentor name or code contains" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  mentor?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  hasMentor?: boolean;
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDateFrom?: string;
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDateTo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  positionCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  projectCode?: string;
  @ApiPropertyOptional({ description: "Exact candidate id" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  candidateId?: string;
  @ApiPropertyOptional({ description: "Exact manager code_1c" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  managerCode1c?: string;
  @ApiPropertyOptional({ description: "Exact mentor code_1c" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^\S+$/)
  mentorCode1c?: string;
}
export class ReviewDocumentsDto extends DocumentListDto {
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class CandidateReviewQueueQueryDto extends ReviewDocumentsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 50,
    description: "Number of candidates, regardless of their document counts",
  })
  declare limit?: number;
  @ApiPropertyOptional({ description: "Candidate id from nextCursor" })
  declare cursor?: string;
}

export class CandidateDocumentDraftFieldDto {
  @ApiProperty() name!: string;
  @ApiProperty({
    oneOf: [{ type: "string", nullable: true }, { type: "boolean" }],
  })
  value!: string | boolean | null;
}
export class CandidateDocumentDraftDto {
  @ApiProperty({ format: "uuid" }) documentUid!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: [CandidateDocumentDraftFieldDto] })
  fields!: CandidateDocumentDraftFieldDto[];
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DocumentStatus, OcrJobStatus } from "@prisma/client";
import {
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
} from "class-validator";
import { Type } from "class-transformer";

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
export class DocumentVersionDto {
  @ApiProperty() documentId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: DocumentStatus, enumName: "DocumentStatus" })
  status!: DocumentStatus;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: String, nullable: true, enum: ["STUB", "EXTERNAL"] })
  ocrSource!: string | null;
  @ApiProperty({ type: [DocumentFileDto] }) files!: DocumentFileDto[];
  @ApiProperty({ type: [DocumentFieldDto] }) fields!: DocumentFieldDto[];
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
export class DocumentDto {
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
  @ApiProperty({ type: String, nullable: true }) candidateId!: string | null;
  @ApiProperty({ type: String, nullable: true }) chatUuid!: string | null;
  @ApiProperty({ type: String, nullable: true }) code1c!: string | null;
  @ApiProperty({ type: String, nullable: true }) deliveryStatus!: string | null;
}
export class DocumentListDto {
  @ApiProperty({ type: [DocumentDto] }) items!: DocumentDto[];
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
export class ReviewDocumentsQueryDto extends CandidateQueryDto {
  @ApiPropertyOptional({ enum: ["IN_REVIEW", "ERP_PENDING", "ALL"] })
  @IsOptional()
  @IsIn(["IN_REVIEW", "ERP_PENDING", "ALL"])
  status?: string;
}
export class ReviewDocumentsDto extends DocumentListDto {
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

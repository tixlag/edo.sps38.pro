import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { CandidateProfileDto } from "../documents/dto/document.dto";

export enum ChatChannel {
  LK = "lk",
  TELEGRAM = "tg",
  WHATSAPP = "wa",
  SMS = "sms",
}
export enum SendStatus {
  PENDING = "PENDING",
  SENT = "SENT",
  FAILED = "FAILED",
  UNKNOWN = "UNKNOWN",
}
export class CommunicationQueryDto {
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
export class CommunicationCandidatesQueryDto extends CommunicationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  statusId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectCode?: string;
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
export class CommunicationCandidatesDto {
  @ApiProperty({ type: [CandidateProfileDto] }) items!: CandidateProfileDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: String, nullable: true }) syncedAt!: string | null;
}
export class ChatRecipientDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ChatChannel, enumName: "ChatChannel" })
  channel!: ChatChannel;
  @ApiProperty() label!: string;
  @ApiProperty() supportsFiles!: boolean;
}
export class ChatTemplateDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() text!: string;
}
export class CommunicationContextDto {
  @ApiProperty({ type: [ChatRecipientDto] }) recipients!: ChatRecipientDto[];
  @ApiProperty({ type: [ChatTemplateDto] }) templates!: ChatTemplateDto[];
  @ApiProperty() canSend!: boolean;
  @ApiProperty({ type: String, nullable: true }) lkUrl!: string | null;
  @ApiProperty({ type: [String] }) unavailableSources!: string[];
}
export class ChatAttachmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() filename!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty({ type: Number, nullable: true }) sizeBytes!: number | null;
}
export class ChatMessageDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ChatChannel, enumName: "ChatChannel" })
  channel!: ChatChannel;
  @ApiProperty() outgoing!: boolean;
  @ApiProperty() author!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty() text!: string;
  @ApiProperty({ type: [ChatAttachmentDto] }) attachments!: ChatAttachmentDto[];
}
export class CommunicationHistoryDto {
  @ApiProperty({ type: [ChatMessageDto] }) items!: ChatMessageDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: [String] }) unavailableSources!: string[];
}
export class SendCommunicationDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
  @ApiProperty({ enum: ChatChannel, enumName: "ChatChannel" })
  @IsEnum(ChatChannel)
  channel!: ChatChannel;
  @ApiProperty({ maxLength: 256 })
  @IsString()
  @MaxLength(256)
  recipientId!: string;
  @ApiProperty({ maxLength: 16000 })
  @IsString()
  @MaxLength(16000)
  text!: string;
  @ApiPropertyOptional({
    type: [String],
    maxItems: 1,
    description:
      "Staged attachment ID. One file per message, as required by LK.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  attachmentIds?: string[];
}
export class CommunicationOperationDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ enum: SendStatus, enumName: "SendStatus" })
  status!: SendStatus;
  @ApiProperty({ type: String, nullable: true }) providerId!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
}
export class ChatDownloadDto {
  @ApiProperty() url!: string;
}
export class ChatLinkDto {
  @ApiProperty() url!: string;
}
export class ChatStreamGrantDto {
  @ApiProperty() token!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
}

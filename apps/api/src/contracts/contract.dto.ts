import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";

export enum ContractState {
  PREPARING = "PREPARING",
  DRAFT = "DRAFT",
  WAITING_EMPLOYEE = "WAITING_EMPLOYEE",
  COMPLETED = "COMPLETED",
  DECLINED = "DECLINED",
  FAILED = "FAILED",
}
export enum ContractBank {
  SBER = "sber",
  T = "t",
  ALFA = "alfa",
}
export enum ConfirmationRole {
  EMPLOYER = "employer",
  EMPLOYEE = "employee",
}
export class ContractTypeDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() source_object!: string;
}
export class ContractTypesDto {
  @ApiProperty({ type: [ContractTypeDto] }) items!: ContractTypeDto[];
}
export class SigningCandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) fullName!: string | null;
  @ApiProperty({ nullable: true, type: String }) birthDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) code1c!: string | null;
}
export class ContractConfirmationDto {
  @ApiProperty({ enum: ConfirmationRole, enumName: "ConfirmationRole" })
  role!: ConfirmationRole;
  @ApiProperty() actorId!: string;
  @ApiProperty() actorLabel!: string;
  @ApiProperty() confirmedAt!: string;
  @ApiProperty({ enum: ["demo"] }) mode!: "demo";
  @ApiProperty({ enum: ContractBank, enumName: "ContractBank", nullable: true })
  bank!: ContractBank | null;
  @ApiProperty() sha256!: string;
}
export class ContractDto {
  @ApiProperty() id!: string;
  @ApiProperty() candidateId!: string;
  @ApiProperty({ nullable: true, type: String }) fullName!: string | null;
  @ApiProperty({ nullable: true, type: String }) birthDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) code1c!: string | null;
  @ApiProperty() documentType!: string;
  @ApiProperty() documentTypeName!: string;
  @ApiProperty({ enum: ContractState, enumName: "ContractState" })
  status!: ContractState;
  @ApiProperty() revision!: number;
  @ApiProperty() version!: number;
  @ApiProperty() hasFile!: boolean;
  @ApiProperty({ nullable: true, type: String }) filename!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiProperty({ nullable: true, type: String }) sentBy!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) sentAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) completedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) errorMessage!: string | null;
  @ApiProperty({ type: [ContractConfirmationDto] })
  confirmations!: ContractConfirmationDto[];
}
export class ContractDetailDto extends ContractDto {
  @ApiProperty({ nullable: true, type: String }) previewUrl!: string | null;
  @ApiProperty({ nullable: true, type: String }) downloadUrl!: string | null;
  @ApiProperty({ nullable: true, type: String }) originalDownloadUrl!:
    | string
    | null;
  @ApiProperty({ nullable: true, type: String }) journalDownloadUrl!:
    | string
    | null;
}
export class ContractsDto {
  @ApiProperty({ type: [ContractDto] }) items!: ContractDto[];
}
export class CreateContractDto {
  @ApiProperty() @IsString() @MaxLength(64) candidateId!: string;
  @ApiProperty() @IsString() @MaxLength(128) documentType!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
  @ApiPropertyOptional({
    default: false,
    description:
      "Create a draft for manual PDF/DOCX upload without requesting ZUP generation",
  })
  @IsOptional()
  @IsBoolean()
  manual?: boolean;
}
export class ContractActionDto {
  @ApiProperty() @IsInt() @Min(0) revision!: number;
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
}
export class ConfirmContractDto extends ContractActionDto {
  @ApiProperty({ enum: ContractBank, enumName: "ContractBank" })
  @IsEnum(ContractBank)
  bank!: ContractBank;
}
export class ContractNotificationDto {
  @ApiProperty() id!: string;
  @ApiProperty() contractId!: string;
  @ApiProperty() message!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) readAt!: string | null;
}
export class ContractNotificationsDto {
  @ApiProperty({ type: [ContractNotificationDto] })
  items!: ContractNotificationDto[];
}
export class ContractErrorDto {
  @ApiProperty() statusCode!: number;
  @ApiProperty() message!: string;
  @ApiProperty({ nullable: true, type: String }) correlationId!: string | null;
}

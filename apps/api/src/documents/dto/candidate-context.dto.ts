import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsUUID, Matches } from "class-validator";
import { CandidateSnapshotDto } from "./document.dto";

export class CandidateDocumentContextDto {
  @ApiProperty({ format: "uuid" }) chatUuid!: string;
  @ApiProperty({ type: String, nullable: true }) code1c!: string | null;
  @ApiProperty() positionCode1c!: string;
  @ApiProperty() citizenship!: string;
  @ApiProperty({ type: String, nullable: true }) projectCode1c!: string | null;
  @ApiPropertyOptional({ type: CandidateSnapshotDto })
  candidateSnapshot?: CandidateSnapshotDto;
}
export class CandidateDocumentUploadRequestDto {
  @ApiProperty({ format: "uuid" }) @IsUUID() documentUid!: string;
  @ApiProperty({ maxLength: 128 })
  @Matches(/^[\x21-\x7e]{1,128}$/)
  idempotencyKey!: string;
}

import { IsArray, ArrayMinSize, ArrayMaxSize, IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { QueryValues } from "../../common/query-values";

export const ENRICHMENT_STATES = [
  "PENDING",
  "RUNNING",
  "READY",
  "RETRY",
] as const;
export class CandidateEnrichmentDto {
  @ApiProperty({ enum: ENRICHMENT_STATES })
  status!: (typeof ENRICHMENT_STATES)[number];
  @ApiProperty() profileReady!: boolean;
  @ApiProperty() documentsReady!: boolean;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  retryAt!: string | null;
}

export class CandidateEnrichmentBatchRequestDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  candidateIds!: string[];
}
export class CandidateEnrichmentBatchDto {
  @ApiProperty({ type: [String] })
  pendingCandidateIds!: string[];
}

export class CandidateBatchStatusQueryDto {
  @QueryValues({ maxLength: 64 })
  candidateIds?: string[];
}

export class CandidateBatchStatusItemDto {
  @ApiProperty()
  candidateId!: string;

  @ApiProperty({ enum: ENRICHMENT_STATES })
  status!: (typeof ENRICHMENT_STATES)[number];

  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  retryAt!: string | null;
}

export class CandidateBatchStatusDto {
  @ApiProperty({ type: [CandidateBatchStatusItemDto] })
  items!: CandidateBatchStatusItemDto[];
}

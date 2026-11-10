import { ApiProperty } from "@nestjs/swagger";

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

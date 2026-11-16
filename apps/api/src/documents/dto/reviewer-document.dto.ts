import { ApiProperty } from "@nestjs/swagger";
import { DocumentFieldDto, PreviousDocumentAvailabilityDto } from "./document.dto";

export class PreviousDocumentDetailsDto {
  @ApiProperty({ type: PreviousDocumentAvailabilityDto }) document!: PreviousDocumentAvailabilityDto;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: [DocumentFieldDto] }) fields!: DocumentFieldDto[];
  @ApiProperty() hasLocalEdits!: boolean;
  @ApiProperty({ enum: ["PENDING", "CONFIRMED", "FAILED"], nullable: true })
  erpEditSyncStatus!: "PENDING" | "CONFIRMED" | "FAILED" | null;
  @ApiProperty({ type: String, nullable: true }) erpEditSyncError!: string | null;
}

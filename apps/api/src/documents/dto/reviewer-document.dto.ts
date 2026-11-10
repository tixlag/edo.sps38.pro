import { ApiProperty } from "@nestjs/swagger";
import { DocumentFieldDto, PreviousDocumentAvailabilityDto } from "./document.dto";

export class PreviousDocumentDetailsDto {
  @ApiProperty({ type: PreviousDocumentAvailabilityDto }) document!: PreviousDocumentAvailabilityDto;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: [DocumentFieldDto] }) fields!: DocumentFieldDto[];
  @ApiProperty() hasLocalEdits!: boolean;
}

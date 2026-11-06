import { ApiProperty } from "@nestjs/swagger";
import { DocumentListDto } from "./document.dto";

export class OwnDocumentListDto extends DocumentListDto {
  @ApiProperty({
    type: [String],
    description: "Confirmed reusable previous document types",
  })
  reusedDocumentUids!: string[];
}

export class OwnHistoricalFileDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}
export class OwnHistoricalDocumentDto {
  @ApiProperty({ enum: ["EDO", "ERP"] }) source!: "EDO" | "ERP";
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: [OwnHistoricalFileDto] }) files!: OwnHistoricalFileDto[];
}
export class OwnDocumentHistoryDto {
  @ApiProperty({ type: [OwnHistoricalDocumentDto] })
  items!: OwnHistoricalDocumentDto[];
  @ApiProperty() erpAvailable!: boolean;
}

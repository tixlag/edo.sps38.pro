import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CandidatePhotoUploadResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: "/api/v1/candidates/cm0123/photo?v=1731320000000" })
  photoPath!: string;
}

export class CandidatePhotoQueryDto {
  @ApiPropertyOptional({ enum: ["thumb", "full"], default: "thumb" })
  size?: "thumb" | "full";

  @ApiPropertyOptional({ description: "Cache busting timestamp or version" })
  v?: string;
}

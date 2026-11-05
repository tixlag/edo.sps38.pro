import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class IgArrivalPageQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  offset?: number;
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  q?: string;
}
export class IgArrivalPeopleQueryDto extends IgArrivalPageQueryDto {
  @ApiProperty({ enum: ["assigned", "issues"] })
  @IsIn(["assigned", "issues"])
  group!: "assigned" | "issues";
  @ApiPropertyOptional({ format: "date" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  arrivalDate?: string;
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  locationUid?: string;
}
export class IgArrivalGroupDto {
  @ApiProperty({ enum: ["assigned", "issues"] }) group!: "assigned" | "issues";
  @ApiProperty({ type: String, nullable: true, format: "date" }) arrivalDate!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) locationUid!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty() total!: number;
  @ApiProperty() approved!: number;
  @ApiProperty() confirmed!: number;
  @ApiProperty() issues!: number;
  @ApiProperty() waitingDocuments!: number;
  @ApiProperty() inReview!: number;
  @ApiProperty() returned!: number;
  @ApiProperty() completed!: number;
  @ApiProperty() sending!: number;
  @ApiProperty() needsAttention!: number;
}
export class IgArrivalGroupsDto {
  @ApiProperty({ type: [IgArrivalGroupDto] }) items!: IgArrivalGroupDto[];
  @ApiProperty({ type: Number, nullable: true }) nextOffset!: number | null;
}
export class IgArrivalPersonDto {
  @ApiProperty({ format: "uuid" }) personUid!: string;
  @ApiProperty() code1c!: string;
  @ApiProperty({ type: String, nullable: true }) candidateId!: string | null;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "uuid" })
  arrivalMemberUid!: string | null;
  @ApiProperty({ enum: ["CURRENT", "CONFLICT"] }) state!:
    | "CURRENT"
    | "CONFLICT";
  @ApiProperty() approvedDocuments!: number;
  @ApiProperty() confirmedDocuments!: number;
  @ApiProperty() employmentConfirmed!: boolean;
  @ApiProperty({
    enum: ["waitingDocuments", "inReview", "returned", "completed", "sending"],
  })
  primaryStatus!:
    | "waitingDocuments"
    | "inReview"
    | "returned"
    | "completed"
    | "sending";
  @ApiProperty() needsAttention!: boolean;
  @ApiProperty({ type: String, nullable: true }) issueCode!: string | null;
}
export class IgArrivalPeopleDto {
  @ApiProperty({ type: [IgArrivalPersonDto] }) items!: IgArrivalPersonDto[];
  @ApiProperty({ type: Number, nullable: true }) nextOffset!: number | null;
}

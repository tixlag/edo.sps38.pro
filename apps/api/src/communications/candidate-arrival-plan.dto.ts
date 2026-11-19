import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export const arrivalPayKinds = ["class", "aup", "director"] as const;
export const arrivalNotificationChannels = ["lk", "erp", "email"] as const;

export class CandidateArrivalPayDto {
  @ApiProperty({ enum: arrivalPayKinds })
  @IsIn(arrivalPayKinds)
  kind!: (typeof arrivalPayKinds)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  classId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  classPlus?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  rate?: number;
}

export class CandidateArrivalPlanFieldsDto {
  @ApiProperty() @IsString() @Length(1, 128) version!: string;
  @ApiProperty() @IsString() @Length(1, 64) positionCode!: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: "date" })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  siteArrivalDate?: string | null;

  @ApiProperty() @IsString() @Length(1, 64) employmentMethod!: string;
  @ApiProperty() @IsString() @MaxLength(300) departurePoint!: string;
  @ApiProperty() @IsString() @MaxLength(50) height!: string;
  @ApiProperty() @IsString() @MaxLength(50) clothingSize!: string;
  @ApiProperty() @IsString() @MaxLength(50) shoeSize!: string;
  @ApiProperty({ format: "uuid" }) @IsUUID() dispatcherId!: string;

  @ApiProperty({ type: CandidateArrivalPayDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CandidateArrivalPayDto)
  pay!: CandidateArrivalPayDto;
}

export class CandidateArrivalPlanQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  projectCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  positionCode?: string;
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  dispatcherId?: string;
}

class CandidateArrivalReferenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

class CandidateArrivalCodeDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

class CandidateArrivalRecipientDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
}

export class CandidateArrivalPlanDto {
  @ApiProperty() version!: string;
  @ApiProperty({ type: CandidateArrivalCodeDto, nullable: true })
  project!: CandidateArrivalCodeDto | null;
  @ApiProperty({ type: CandidateArrivalCodeDto, nullable: true })
  position!: CandidateArrivalCodeDto | null;
  @ApiProperty({ type: String, format: "date", nullable: true })
  plannedArrivalDate!: string | null;
  @ApiProperty({ type: String, format: "date", nullable: true })
  siteArrivalDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) employmentMethod!:
    | string
    | null;
  @ApiProperty({ type: [CandidateArrivalReferenceDto] })
  employmentMethods!: CandidateArrivalReferenceDto[];
  @ApiProperty() departurePoint!: string;
  @ApiProperty() height!: string;
  @ApiProperty() clothingSize!: string;
  @ApiProperty() shoeSize!: string;
  @ApiProperty({ type: CandidateArrivalReferenceDto, nullable: true })
  dispatcher!: CandidateArrivalReferenceDto | null;
  @ApiProperty({ type: [CandidateArrivalRecipientDto] })
  recipients!: CandidateArrivalRecipientDto[];
  @ApiProperty({ type: CandidateArrivalPayDto, nullable: true })
  pay!: CandidateArrivalPayDto | null;
  @ApiProperty({ type: [CandidateArrivalReferenceDto] })
  classes!: CandidateArrivalReferenceDto[];
  @ApiProperty() allowsClassPlus!: boolean;
  @ApiProperty() allowsAup!: boolean;
  @ApiProperty() allowsDirector!: boolean;
  @ApiProperty({ type: Number, nullable: true }) directorRateLimit!:
    | number
    | null;
}

class CandidateArrivalNotificationDto {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: arrivalNotificationChannels })
  channel!: (typeof arrivalNotificationChannels)[number];
  @ApiProperty() status!: string;
}

export class CandidateArrivalPlanNotificationsDto {
  @ApiProperty({ type: [CandidateArrivalNotificationDto] })
  items!: CandidateArrivalNotificationDto[];
}

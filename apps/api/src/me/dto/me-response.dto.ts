import { ApiProperty } from '@nestjs/swagger';

export class LocationScopeDto {
  @ApiProperty({ example: false })
  all!: boolean;

  @ApiProperty({ example: [98, 148], type: [Number] })
  locationIds!: number[];
}

export class MeResponseDto {
  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  uuid!: string;

  @ApiProperty({ example: 'УП00040092', nullable: true, type: String })
  code1c!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Name from the LK projection, matched only by JWT code1c/uuid' })
  fullName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  positionName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  departmentName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  organizationName!: string | null;

  @ApiProperty({ example: { '20000': [], '20007': ['98', '148'] } })
  permissions!: Record<string, string[]>;

  @ApiProperty({ type: LocationScopeDto })
  locationScope!: LocationScopeDto;
}

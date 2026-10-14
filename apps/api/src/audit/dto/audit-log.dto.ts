import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class AuditLogItemDto {
  @ApiProperty({ description: 'Audit row id' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Author uuid (JWT sub); null for system rows without actor',
  })
  actorId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Author display name from the local LK projection (by uuid, fallback by code1c); never matched by full name',
  })
  actorName!: string | null;

  @ApiProperty({ enum: AuditAction, enumName: 'AuditAction' })
  action!: AuditAction;

  @ApiProperty({ description: 'Audited entity type, e.g. Document or Employee' })
  entityType!: string;

  @ApiProperty({ description: 'Audited entity id' })
  entityId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Return reason for DOCUMENT_RETURNED rows (taken from after.rejectionReason)',
  })
  rejectionReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Frontend deep-link hint, e.g. /documents/<id>; null when no route is known',
  })
  linkHint!: string | null;
}

export class AuditLogListDto {
  @ApiProperty({ type: [AuditLogItemDto] })
  items!: AuditLogItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor for the next page; null when exhausted',
  })
  nextCursor!: string | null;
}

export class AuditLogQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description: 'Filter by author uuid; the literal "me" means the caller',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'When true, show only the caller actions',
  })
  @IsOptional()
  @Transform(({ value }) => {
    const v = Array.isArray(value) ? value[0] : value;
    return v === true || v === 1 || v === 'true' || v === '1';
  })
  @IsBoolean()
  mine?: boolean;

  @ApiPropertyOptional({ enum: AuditAction, enumName: 'AuditAction' })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityType?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous AuditLogListDto.nextCursor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}

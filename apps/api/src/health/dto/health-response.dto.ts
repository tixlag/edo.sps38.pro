import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ example: '0.1.0' })
  version!: string;

  @ApiProperty({ example: '2026-09-29T12:00:00.000Z' })
  time!: string;
}

export class ReadinessCheckDto {
  @ApiProperty({ example: 'up' })
  status!: string;

  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ example: 'connection refused', required: false })
  error?: string;
}

export class ReadyResponseDto {
  @ApiProperty({ example: 'ready' })
  status!: string;

  @ApiProperty({ type: ReadinessCheckDto })
  mariadb!: ReadinessCheckDto;

  @ApiProperty({ type: ReadinessCheckDto })
  rabbitmq!: ReadinessCheckDto;

  @ApiProperty({ type: ReadinessCheckDto })
  redis!: ReadinessCheckDto;
}

export class IntegrationHealthDto {
  @ApiProperty({ example: 'healthy' })
  status!: string;

  @ApiProperty({ example: '2026-10-02T12:00:00.000Z' })
  time!: string;

  @ApiProperty({ type: ReadinessCheckDto })
  redis!: ReadinessCheckDto;

  @ApiProperty({ type: ReadinessCheckDto })
  consumer!: ReadinessCheckDto;

  @ApiProperty({ type: ReadinessCheckDto })
  bootstrap!: ReadinessCheckDto;

  @ApiProperty({ type: ReadinessCheckDto })
  freshness!: ReadinessCheckDto;

  @ApiProperty({ example: 0, required: false })
  pendingMessages?: number;

  @ApiProperty({ example: 0, required: false })
  dlqMessages?: number;

  @ApiProperty({ example: 'run-abc', required: false })
  lastSyncRunId?: string;

  @ApiProperty({ example: '2026-10-01T10:00:00.000Z', required: false })
  lastSyncFinishedAt?: string;
}

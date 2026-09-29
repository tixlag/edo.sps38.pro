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

import { ApiProperty } from '@nestjs/swagger';

export class KpiDto {
  @ApiProperty({ example: 'queue' })
  key!: string;

  @ApiProperty({ example: 'Очередь проверки' })
  label!: string;

  @ApiProperty({ example: '11' })
  value!: string;

  @ApiProperty({ example: 'документов ждут проверки' })
  hint!: string;
}

export class WeeklyBarDto {
  @ApiProperty({ example: 'Пн' })
  day!: string;

  @ApiProperty({ example: 4 })
  value!: number;
}

export class StageSliceDto {
  @ApiProperty({ example: 'Оформлены' })
  label!: string;

  @ApiProperty({ example: 18 })
  value!: number;
}

export class ActivityItemDto {
  @ApiProperty({ example: 'doc-check' })
  kind!: string;

  @ApiProperty({ example: 'Проверка документа — СНИЛС — Холов Джамшед Фирузович' })
  title!: string;

  @ApiProperty({ example: '2 мин назад' })
  time!: string;
}

export class BlockedItemDto {
  @ApiProperty({ example: 'Токтогулов Айбек Русланович' })
  fullName!: string;

  @ApiProperty({ example: 'Проверка патента' })
  step!: string;
}

export class TaskItemDto {
  @ApiProperty({ example: 'Проверить страховой полис ДМС — Назаров Фаррух' })
  title!: string;

  @ApiProperty({ example: 'today' })
  due!: string;
}

export class DashboardResponseDto {
  @ApiProperty({ type: [KpiDto] })
  kpis!: KpiDto[];

  @ApiProperty({ type: [WeeklyBarDto] })
  weekly!: WeeklyBarDto[];

  @ApiProperty({ type: [StageSliceDto] })
  stages!: StageSliceDto[];

  @ApiProperty({ type: [ActivityItemDto] })
  activity!: ActivityItemDto[];

  @ApiProperty({ type: [BlockedItemDto] })
  blocked!: BlockedItemDto[];

  @ApiProperty({ type: [TaskItemDto] })
  tasks!: TaskItemDto[];

  @ApiProperty({ example: 'seed' })
  source!: string;
}

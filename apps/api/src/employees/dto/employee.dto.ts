import { ApiProperty } from '@nestjs/swagger';
import { EmployeeStatus } from '../employee-status.enum';

export class EmployeeDto {
  @ApiProperty({ example: 'cuid_1' })
  id!: string;

  @ApiProperty({ example: 'Каримов Азиз Шарифович' })
  fullName!: string;

  @ApiProperty({ example: 'Таджикистан', nullable: true, type: String })
  country!: string | null;

  @ApiProperty({ example: 'Монолитчик', nullable: true, type: String })
  position!: string | null;

  @ApiProperty({ enum: EmployeeStatus, example: EmployeeStatus.IN_REVIEW })
  status!: EmployeeStatus;

  @ApiProperty({ example: 'Проверка документов', nullable: true, type: String })
  stage!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

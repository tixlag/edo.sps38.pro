import { ApiProperty } from '@nestjs/swagger';
import { EmployeeDto } from './employee.dto';

export class EmployeeListResponseDto {
  @ApiProperty({ type: [EmployeeDto] })
  items!: EmployeeDto[];

  @ApiProperty({ example: 5 })
  total!: number;
}

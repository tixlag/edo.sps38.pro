import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EmployeesService } from './employees.service';
import { EmployeeDto } from './dto/employee.dto';
import { EmployeeListResponseDto } from './dto/employee-list-response.dto';

@ApiTags('employees')
@ApiBearerAuth('access-jwt')
@Controller('v1/employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @ApiOperation({ summary: 'List employees (first vertical slice)', operationId: 'listEmployees' })
  @ApiResponse({ status: 200, type: EmployeeListResponseDto })
  @ApiResponse({ status: 401, description: 'Missing bearer token' })
  async list(): Promise<EmployeeListResponseDto> {
    const { items, total } = await this.employees.list();
    return { items, total };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get employee by id', operationId: 'getEmployee' })
  @ApiResponse({ status: 200, type: EmployeeDto })
  @ApiResponse({ status: 401, description: 'Missing bearer token' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async getById(@Param('id') id: string): Promise<EmployeeDto> {
    const employee = await this.employees.getById(id);
    if (!employee) throw new NotFoundException(`Employee ${id} not found`);
    return employee;
  }
}

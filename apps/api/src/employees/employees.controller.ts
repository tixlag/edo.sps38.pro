import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EmployeesService } from './employees.service';
import { EmployeeDto } from './dto/employee.dto';
import { EmployeeListResponseDto } from './dto/employee-list-response.dto';
import { RequireAccessRule } from '../auth/require-access-rule.decorator';
import { EdoAccessRule } from '../auth/edo-access-rule';

@ApiTags('employees')
@ApiBearerAuth('access-jwt')
@Controller('v1/employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({ summary: 'List employees (EDO domain)', operationId: 'listEmployees' })
  @ApiResponse({ status: 200, type: EmployeeListResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  @ApiResponse({ status: 403, description: 'Missing required EDO access rule' })
  async list(): Promise<EmployeeListResponseDto> {
    return this.employees.list();
  }

  @Get(':id')
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({ summary: 'Get employee by id', operationId: 'getEmployee' })
  @ApiResponse({ status: 200, type: EmployeeDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  @ApiResponse({ status: 403, description: 'Missing required EDO access rule' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async getById(@Param('id') id: string): Promise<EmployeeDto> {
    const employee = await this.employees.getById(id);
    if (!employee) throw new NotFoundException(`Employee ${id} not found`);
    return employee;
  }
}

import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EmployeesService } from './employees.service';
import { EmployeeDto } from './dto/employee.dto';
import { EmployeeListResponseDto } from './dto/employee-list-response.dto';
import { RequireAccessRule } from '../auth/require-access-rule.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth-principal';
import { EdoAccessRule } from '../auth/edo-access-rule';

@ApiTags('employees')
@ApiBearerAuth('access-jwt')
@Controller('v1/employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({ summary: 'List employees (EDO domain, location-scoped)', operationId: 'listEmployees' })
  @ApiResponse({ status: 200, type: EmployeeListResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  @ApiResponse({ status: 403, description: 'Missing required EDO access rule' })
  async list(@CurrentPrincipal() principal?: AuthPrincipal): Promise<EmployeeListResponseDto> {
    return this.employees.list(principal);
  }

  @Get(':id')
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({ summary: 'Get employee by id (location-scoped)', operationId: 'getEmployee' })
  @ApiResponse({ status: 200, type: EmployeeDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  @ApiResponse({ status: 403, description: 'Missing required EDO access rule' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async getById(@Param('id') id: string, @CurrentPrincipal() principal?: AuthPrincipal): Promise<EmployeeDto> {
    const employee = await this.employees.getById(id, principal);
    if (!employee) throw new NotFoundException(`Employee ${id} not found`);
    return employee;
  }
}

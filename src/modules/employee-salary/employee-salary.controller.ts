import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { EmployeeSalaryService } from './employee-salary.service';
import { AssignSalaryProfileDto, CreateSalaryRevisionDto } from './dto/employee-salary.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Employee Salary Profiles')
@ApiBearerAuth()
@Controller({ path: 'employee-salary', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeeSalaryController {
  constructor(private readonly service: EmployeeSalaryService) {}

  @Post()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Assign or update an employee salary profile & bank details' })
  async assignProfile(@Body() dto: AssignSalaryProfileDto) {
    return this.service.assignProfile(dto);
  }

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'List employee salary profiles with search and filtering' })
  async findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get('employee/:employeeId')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM, UserRole.STAFF)
  @ApiOperation({ summary: 'Get employee salary profile and revision history by Employee ID' })
  async findByEmployeeId(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.service.findByEmployeeId(employeeId);
  }

  @Post('employee/:employeeId/revise')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Submit a salary revision / increment for an employee' })
  async reviseSalary(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateSalaryRevisionDto,
  ) {
    return this.service.reviseSalary(employeeId, dto);
  }
}

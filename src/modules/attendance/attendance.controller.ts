import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  BadRequestException,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { PayrollService } from '../payroll/payroll.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Employee Attendance')
@ApiBearerAuth()
@Controller({ path: 'attendance', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(
    private readonly service: AttendanceService,
    private readonly payrollService: PayrollService,
  ) {}

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all attendance logs with filters' })
  async findAll(
    @Query('date') date?: string,
    @Query('employeeId') employeeId?: string,
    @Query('branchId') branchId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return this.service.findAll({ date, employeeId, branchId, categoryId, page, limit });
  }

  @Get('stats')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get daily attendance statistics' })
  async getStats(@Query('date') date?: string, @Query('branchId') branchId?: string) {
    return this.service.getStats(date, branchId);
  }

  @Post('mark')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Mark employee attendance' })
  async mark(@Body() body: any, @Req() req: any) {
    if (!body.employeeId || !body.date || !body.status) {
      throw new BadRequestException('Employee ID, date, and status are required');
    }
    if (!['Present', 'Absent', 'Leave', 'Half Day', 'Late'].includes(body.status)) {
      throw new BadRequestException('Invalid status. Must be Present, Absent, Leave, Half Day, or Late');
    }
    return this.service.mark(body, req.user.id);
  }

  @Put(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Edit employee attendance record' })
  async edit(@Param('id') id: string, @Body() body: any) {
    return this.service.edit(id, body);
  }

  @Post('approve')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Approve multiple attendance logs' })
  async approve(@Body('ids') ids: string[], @Req() req: any) {
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('A list of attendance record IDs is required');
    }
    return this.service.approve(ids, req.user.id);
  }

  @Get(':employeeId/payroll-preview')
  @Roles(UserRole.HR, UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Preview monthly payroll based on attendance' })
  async previewPayroll(
    @Param('employeeId') employeeId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.payrollService.previewEmployeePayroll(employeeId, parseInt(month, 10), parseInt(year, 10));
  }

  @Post(':employeeId/generate-payroll')
  @Roles(UserRole.HR, UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Generate monthly payroll based on attendance' })
  async generatePayroll(
    @Param('employeeId') employeeId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Body() body?: { month?: number; year?: number },
  ) {
    const m = Number(body?.month ?? month);
    const y = Number(body?.year ?? year);
    if (!m || !y) {
      throw new BadRequestException('month and year are required');
    }
    return this.payrollService.runEmployeePayroll(employeeId, m, y);
  }

  @Get('payrolls/all')
  @Roles(UserRole.HR, UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all generated employee payrolls' })
  async getEmployeePayrolls() {
    return this.payrollService.getEmployeePayrolls();
  }
}

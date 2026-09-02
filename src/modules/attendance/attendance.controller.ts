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
import { PipelineAttendanceProjectionService } from './pipeline-attendance-projection.service';
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
    private readonly projection: PipelineAttendanceProjectionService,
    private readonly payrollService: PayrollService,
  ) {}

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
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
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get daily attendance statistics' })
  async getStats(@Query('date') date?: string, @Query('branchId') branchId?: string) {
    return this.service.getStats(date, branchId);
  }

  @Get('payrolls/all')
  @Roles(UserRole.HR, UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all generated employee payrolls' })
  async getEmployeePayrolls() {
    return this.payrollService.getEmployeePayrolls();
  }

  @Post('mark')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Mark employee attendance, including on a staff member behalf',
    description:
      'Writes the HR attendance ledger, and for an employee onboarded out of the ' +
      'S1-S5 pipeline also mirrors the day into staff_daily_attendance, which is what ' +
      'payroll and client invoicing count. Refuses to overwrite a live self-check-in ' +
      'from the staff mobile app unless overrideSelfCheckIn: true is passed.',
  })
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
  @ApiOperation({
    summary: 'Edit employee attendance record (re-mirrors to the pipeline on a status change)',
  })
  async edit(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    return this.service.editAndMirror(id, body, req.user.id);
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

  @Post('sync-from-pipeline')
  @Roles(UserRole.HR, UserRole.FINANCE, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Pull field check-ins into the HR attendance ledger',
    description:
      'Deployed staff mark their own attendance from the mobile app, which lands in the ' +
      'pipeline tables. Employee payroll counts the HR attendance ledger and nothing else, ' +
      'so those days have to be projected across or the month reads as zero billable days. ' +
      'Runs nightly on its own; this endpoint forces it for a specific month or employee. ' +
      'Days an HR user marked by hand are never overwritten and are reported as skippedManual.',
  })
  async syncFromPipeline(
    @Body() body: { month?: number; year?: number; employeeId?: string },
  ) {
    const now = new Date();
    const month = Number(body?.month ?? now.getMonth() + 1);
    const year = Number(body?.year ?? now.getFullYear());
    if (month < 1 || month > 12 || !Number.isInteger(month)) {
      throw new BadRequestException('month must be a whole number between 1 and 12');
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year must be a whole number between 2000 and 2100');
    }
    return this.projection.projectMonth({ month, year, employeeId: body?.employeeId });
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
    // Pull the month's field check-ins across first. Payroll counts only the HR
    // ledger, so without this a pipeline employee who marked every day from the
    // mobile app would be paid for zero of them. Cheap and idempotent, and it
    // leaves HR-marked days untouched. Still worth doing before the refusal
    // below, because the caller's next step is to run payroll on the placement
    // and that reads the same ledger.
    await this.projection.projectMonth({ month: m, year: y, employeeId });

    // Throws: the HR payroll engine is retired and this employee is paid
    // through their placement instead. See ONE_STAFF_MODEL_PLAN.md §B6.
    return this.payrollService.runEmployeePayroll(employeeId, m, y);
  }
}

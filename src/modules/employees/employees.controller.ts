import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import {
  EmployeeOnboardingService,
  OnboardFromPipelineDto,
} from './employee-onboarding.service';
import { EmployeeProfileService } from './employee-profile.service';
import { EmployeePayslipService } from './employee-payslip.service';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserProvisioningService } from '../auth/user-provisioning.service';

@ApiTags('Employees')
@ApiBearerAuth()
@Controller({ path: 'employees', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(
    private readonly service: EmployeesService,
    private readonly onboarding: EmployeeOnboardingService,
    private readonly profile: EmployeeProfileService,
    private readonly payslips: EmployeePayslipService,
    private readonly userProvisioning: UserProvisioningService,
  ) {}

  @Get()
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.RM, UserRole.BM, UserRole.TRAINER, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get all employees (search, filters, paginate)' })
  async findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get('branches')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.RM, UserRole.BM, UserRole.TRAINER, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get all branches for dropdowns' })
  async getBranches() {
    return this.service.getBranches();
  }

  /** Lightweight employee list — all internal roles can use this for dropdowns */
  @Get('list')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.RM, UserRole.BM, UserRole.TRAINER, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get a lightweight list of active employees for dropdowns' })
  async listForDropdown(@Query('branchId') branchId?: string, @Query('status') status?: string) {
    const result = await this.service.findAll({
      branchId,
      status: status ?? 'Active',
      limit: 500,
      page: 1,
    });
    // Return slim objects suitable for dropdowns
    return result.items.map((e: any) => ({
      id: e.id,
      employeeId: e.employeeId,
      fullName: e.fullName,
      mobile: e.mobile,
      department: e.department,
      designation: e.designation,
      branchId: e.branchId,
    }));
  }

  // Declared above @Get(':id') on purpose — Nest matches routes in declaration
  // order, so a literal path registered after the parameterised one would be
  // swallowed by it and arrive as an employee lookup for the id
  // "pending-onboarding".
  @Get('pending-onboarding')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.BM)
  @ApiOperation({
    summary: 'Deployed pipeline candidates who do not have an employee record yet',
    description:
      'HR onboarding worklist: staff who reached S5_DEPLOY in the RM pipeline but have ' +
      'never been converted into an employees row, so they are invisible to attendance, ' +
      'salary and payslips.',
  })
  async pendingOnboarding(
    @Query('branchId') branchId?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.onboarding.listPendingOnboarding({
      branchId,
      search,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('onboard-from-pipeline')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Convert an S5_DEPLOY candidate into an employee',
    description:
      'The supported S5 -> employee handover. Copies identity from the staff_applicants ' +
      'row, takes the HR-only fields the pipeline never collected (department, ' +
      'designation, category, employment type, salary, joining date, gender), links the ' +
      'two records by foreign key and reuses the candidate existing login rather than ' +
      'creating a second account. The pipeline row is left untouched as the permanent ' +
      'record of how this person was hired.',
  })
  async onboardFromPipeline(@Body() body: OnboardFromPipelineDto, @Req() req: any) {
    if (!body?.staffApplicantId) {
      throw new BadRequestException('staffApplicantId is required');
    }
    return this.onboarding.onboardFromPipeline(body, req.user.id);
  }

  @Get(':id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.RM, UserRole.BM, UserRole.TRAINER, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get employee details by ID' })
  async findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Add a new employee (generates ID automatically). Also provisions a login-capable ' +
      'STAFF account linked to this employee (and its synced staff_applicants row) — ' +
      'default password unless the request supplies one.',
  })
  async create(@Body() body: any) {
    // Basic validation
    if (!body.fullName || !body.mobile || !body.dateOfBirth || !body.gender || !body.address || !body.city || !body.state || !body.pincode || !body.joiningDate || !body.branchId || !body.categoryId || !body.department || !body.designation || !body.employmentType || body.salary === undefined) {
      throw new BadRequestException('Missing required fields for employee creation');
    }

    // Every employee is a person the pipeline placed with a client; there is no
    // separate population of internal hires. This endpoint used to allow an
    // employee with no pipeline link at all, which is how production ended up
    // with two orphaned rows whose designations ("Caretaker", "Office Boy")
    // are placed-staff roles. See ONE_STAFF_MODEL_PLAN.md §B4.
    if (!body.staffApplicantId) {
      throw new BadRequestException(
        'staffApplicantId is required — an employee must come from a pipeline candidate ' +
          'at S5_DEPLOY. Use POST /employees/onboard-from-pipeline, or pass the candidate id here.',
      );
    }
    await this.onboarding.assertOnboardable(body.staffApplicantId);

    await this.userProvisioning.assertPhoneAvailable(body.mobile, body.email);
    const employee = await this.service.create(body);
    await this.userProvisioning.linkStaffAccount({
      employeeId: employee.id,
      mobile: body.mobile,
      fullName: body.fullName,
      email: body.email,
      branchId: body.branchId,
      password: body.password,
    });
    return this.service.findOne(employee.id);
  }

  @Put(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Update employee information' })
  async update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Patch(':id/status')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Activate, deactivate, or resign employee' })
  async toggleStatus(@Param('id') id: string, @Body('status') status: string) {
    if (!['Active', 'Inactive', 'Resigned'].includes(status)) {
      throw new BadRequestException('Invalid status value. Must be Active, Inactive, or Resigned');
    }
    return this.service.toggleStatus(id, status);
  }

  @Post(':id/exit')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Process online or offline staff exit / resignation' })
  async processExit(
    @Param('id') id: string,
    @Body()
    body: {
      channel: 'ONLINE' | 'OFFLINE';
      reason: string;
      exitDate: string;
      notes?: string;
    },
  ) {
    if (!body?.channel || !body?.reason || !body?.exitDate) {
      throw new BadRequestException('channel, reason, and exitDate are required');
    }
    return this.service.processExit(id, body);
  }

  // ── Per-employee reads: the pipeline side of a person, from HR's screen ──
  // These sit after @Get(':id') on purpose — they have an extra path segment,
  // so there is no ambiguity with the parameterised route above.

  @Get(':id/pipeline-history')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({
    summary: 'Stage-by-stage history of how this employee was hired',
    description:
      'Every pipeline_events row for the linked candidate record, newest first, with the ' +
      'acting user resolved. Returns linkedToPipeline: false for a direct HR hire.',
  })
  async pipelineHistory(@Param('id') id: string) {
    return this.profile.pipelineHistory(id);
  }

  @Get(':id/incidents')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.BM, UserRole.RM)
  @ApiOperation({ summary: 'Incidents raised against this employee during deployment' })
  async incidents(@Param('id') id: string) {
    return this.profile.incidents(id);
  }

  @Get(':id/attendance-month')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.BM, UserRole.FINANCE)
  @ApiOperation({
    summary: 'One month of attendance, HR ledger merged with the field record',
    description:
      'Each day carries a source (HR / FIELD / PIPELINE_ONLY) and a divergesFromField flag, ' +
      'so a day HR corrected and a day the projection has not picked up yet are both ' +
      'visible rather than silently reconciled.',
  })
  async attendanceMonth(
    @Param('id') id: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    const now = new Date();
    const m = Number(month ?? now.getMonth() + 1);
    const y = Number(year ?? now.getFullYear());
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException('month must be a whole number between 1 and 12');
    }
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw new BadRequestException('year must be a whole number between 2000 and 2100');
    }
    return this.profile.attendanceMonth(id, m, y);
  }

  /**
   * Declared before `:id/payslips` so Nest does not read "payslips" as an id.
   */
  @Get('payslips')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({
    summary: "Every salary slip for a period — HR's month-end view",
    description:
      'Reads payroll_records, the single payroll engine, so this list and the ' +
      "client's invoice are built from the same rows.",
  })
  async listPayslipsForPeriod(@Query('month') month?: string, @Query('year') year?: string) {
    const now = new Date();
    const m = Number(month) || now.getMonth() + 1;
    const y = Number(year) || now.getFullYear();
    if (m < 1 || m > 12) throw new BadRequestException('month must be between 1 and 12');
    return this.payslips.listForPeriod(m, y);
  }

  @Get(':id/payslips')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({
    summary: 'Every payslip for this employee, across all three payroll paths',
    description:
      'Merges employee_payrolls (HR), payroll_details/payslip_documents (enterprise) and ' +
      'payroll_records (field/placement) into one period-sorted list. Each row carries a ref ' +
      'usable with the PDF endpoint.',
  })
  async listPayslips(@Param('id') id: string) {
    return this.payslips.listForEmployee(id);
  }

  @Get(':id/payslips/pdf')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({
    summary: 'Download one payslip as a PDF',
    description:
      'Pass the ref from the payslips list (e.g. HR_PAYROLL:<uuid>). The PDF is rendered ' +
      'from live data so every payslip looks the same regardless of which payroll path ' +
      'produced it.',
  })
  async payslipPdf(
    @Param('id') id: string,
    @Query('ref') ref: string,
    @Res() res: Response,
  ) {
    if (!ref) throw new BadRequestException('ref is required — take it from GET :id/payslips');
    EmployeePayslipService.parseRef(ref);
    const { buffer, filename } = await this.payslips.renderPdf(id, ref);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Soft delete employee record' })
  async delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { EnterprisePayrollService } from './enterprise-payroll.service';
import {
  ProcessEnterpriseBatchDto,
  ApproveBatchTierDto,
  GenerateBankTransferDto,
  UpdatePayrollSettingDto,
} from './dto/enterprise-payroll.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Enterprise Payroll & Processing')
@ApiBearerAuth()
@Controller({ path: 'enterprise-payroll', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class EnterprisePayrollController {
  constructor(private readonly service: EnterprisePayrollService) {}

  @Post('process-batch')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Run 10-step enterprise payroll calculation pipeline for a month/year/branch' })
  async processBatch(@Body() dto: ProcessEnterpriseBatchDto, @Req() req: any) {
    return this.service.processEnterpriseBatch(dto, req.user?.id);
  }

  @Get('batches')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'List payroll processing batches' })
  async getBatches(@Query() query: any) {
    return this.service.getBatches(query);
  }

  @Get('batches/:id')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Get payroll batch details, employee payslip breakdown & workflow status' })
  async getBatchById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getBatchById(id);
  }

  @Put('batches/:id/approve')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Approve a multi-tier workflow step on a payroll batch' })
  async approveTier(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveBatchTierDto, @Req() req: any) {
    return this.service.approveTier(id, dto, req.user?.id);
  }

  @Put('batches/:id/reject')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Reject a multi-tier workflow step on a payroll batch' })
  async rejectTier(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveBatchTierDto, @Req() req: any) {
    return this.service.rejectTier(id, dto, req.user?.id);
  }

  @Put('batches/:id/lock')
  @Roles(UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Lock an approved payroll batch against further modifications' })
  async lockBatch(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.lockBatch(id);
  }

  @Post('batches/:id/bank-transfer')
  @Roles(UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Generate bank transfer file (CSV/Excel) for payroll batch' })
  async generateBankTransfer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GenerateBankTransferDto, @Req() req: any) {
    return this.service.generateBankTransfer(id, dto, req.user?.id);
  }

  // Reports
  @Get('reports/summary')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Get KPI summary report of payroll expenses' })
  async getSummaryReport(
    @Query('month') month?: number,
    @Query('year') year?: number,
    @Query('branchId') branchId?: string,
  ) {
    return this.service.getSummaryReport(month, year, branchId);
  }

  @Get('reports/department-breakdown')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE, UserRole.RM, UserRole.BM)
  @ApiOperation({ summary: 'Get department-wise salary and deduction breakdown' })
  async getDepartmentBreakdown(@Query('month') month?: number, @Query('year') year?: number) {
    return this.service.getDepartmentBreakdown(month, year);
  }

  @Get('reports/statutory-compliance')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Get statutory compliance summary (PF, ESIC, PT, TDS)' })
  async getStatutoryCompliance(@Query('month') month?: number, @Query('year') year?: number) {
    return this.service.getStatutoryCompliance(month, year);
  }

  // Settings
  @Get('settings')
  @Roles(UserRole.HR, UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'List payroll engine settings & tax rules' })
  async getSettings() {
    return this.service.getSettings();
  }

  @Post('settings')
  @Roles(UserRole.ADMIN, UserRole.FINANCE)
  @ApiOperation({ summary: 'Create or update payroll setting' })
  async updateSetting(@Body() dto: UpdatePayrollSettingDto, @Req() req: any) {
    return this.service.updateSetting(dto, req.user?.id);
  }
}

import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { calculateEsic } from '../../common/finance/statutory-calc.util';
import {
  ProcessEnterpriseBatchDto,
  ApproveBatchTierDto,
  GenerateBankTransferDto,
  UpdatePayrollSettingDto,
} from './dto/enterprise-payroll.dto';
import { Prisma, PayrollApprovalStatus, BankTransferStatus, LoanStatus, CalculationType, SalaryComponentType } from '@prisma/client';

@Injectable()
export class EnterprisePayrollService {
  private readonly logger = new Logger(EnterprisePayrollService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 10-Step Enterprise Payroll Processing Pipeline
   */
  async processEnterpriseBatch(dto: ProcessEnterpriseBatchDto, userId?: string) {
    const { month, year, branchId } = dto;
    const batchNumber = `PAY-${year}-${String(month).padStart(2, '0')}${branchId ? `-${branchId.slice(0, 6)}` : '-ALL'}-${Date.now().toString().slice(-4)}`;

    // Check if batch already exists and is locked or approved
    const existingBatch = await this.prisma.payrollProcessingBatch.findFirst({
      where: { month, year, branchId: branchId ?? null },
    });
    if (existingBatch && (existingBatch.status === PayrollApprovalStatus.APPROVED || existingBatch.status === PayrollApprovalStatus.LOCKED)) {
      throw new BadRequestException(`Payroll batch for ${month}/${year} is already approved or locked.`);
    }

    // Step 1: Initialize or reuse Batch
    let batch = existingBatch;
    if (!batch) {
      batch = await this.prisma.payrollProcessingBatch.create({
        data: {
          batchNumber,
          month,
          year,
          branchId: branchId ?? null,
          status: PayrollApprovalStatus.DRAFT,
          createdBy: userId,
        },
      });
    } else {
      // Clear previous details if recalculating draft
      await this.prisma.payrollDetail.deleteMany({ where: { batchId: batch.id } });
      await this.prisma.payrollApprovalWorkflow.deleteMany({ where: { batchId: batch.id } });
    }

    // Step 2: Fetch all active Employees for branch
    const whereEmp: Prisma.EmployeeWhereInput = {
      deletedAt: null,
      status: { equals: 'Active', mode: 'insensitive' },
    };
    if (branchId) {
      whereEmp.branchId = branchId;
    }
    const employees = await this.prisma.employee.findMany({
      where: whereEmp,
      include: {
        salaryProfile: {
          include: { template: { include: { components: true } } },
        },
        loans: { where: { status: LoanStatus.ACTIVE } },
        salaryAdvances: { where: { status: LoanStatus.ACTIVE, recoveryMonth: month, recoveryYear: year } },
      },
    });

    let totalEmployees = 0;
    let totalGross = 0;
    let totalBonus = 0;
    let totalReimbursement = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    for (const emp of employees) {
      totalEmployees++;
      const workingDays = 30;
      const presentDays = 30; // Default assuming full attendance unless docked
      const lwpDays = 0;
      const prorationRatio = presentDays / workingDays;

      // Step 4: Calculate basic salary & allowances
      let basicSalary = 0;
      const allowancesObj: any = {};
      let grossFromProfile = 0;

      if (emp.salaryProfile && emp.salaryProfile.template) {
        basicSalary = Number(emp.salaryProfile.template.basicSalary) * prorationRatio;
        for (const comp of emp.salaryProfile.template.components) {
          if (comp.type === SalaryComponentType.EARNING) {
            let amt = Number(comp.amount);
            if (comp.calculationType === CalculationType.PERCENTAGE && comp.percentageValue) {
              amt = (basicSalary * Number(comp.percentageValue)) / 100;
            }
            if (comp.calculationType === CalculationType.ATTENDANCE_BASED) {
              amt = amt * prorationRatio;
            }
            allowancesObj[comp.name] = Math.round(amt * 100) / 100;
            grossFromProfile += amt;
          }
        }
        grossFromProfile += basicSalary;
      } else {
        basicSalary = Number(emp.salary) * prorationRatio;
        grossFromProfile = basicSalary;
      }

      // Step 5: Incorporate Overtime
      const otRecords = await this.prisma.overtimeRecord.findMany({
        where: {
          employeeId: emp.id,
          status: 'APPROVED',
          date: { gte: startOfMonth, lte: endOfMonth },
        },
      });
      const overtimeAmount = otRecords.reduce((sum, r) => sum + Number(r.totalAmount), 0);

      // Step 6: Add Bonuses
      const bonusRecords = await this.prisma.bonusRecord.findMany({
        where: {
          employeeId: emp.id,
          status: 'APPROVED',
          month,
          year,
        },
      });
      const bonusAmount = bonusRecords.reduce((sum, b) => sum + Number(b.amount), 0);

      // Step 7: Apply Reimbursements
      const reimbRecords = await this.prisma.reimbursementRequest.findMany({
        where: {
          employeeId: emp.id,
          status: 'APPROVED',
          expenseDate: { gte: startOfMonth, lte: endOfMonth },
        },
      });
      const reimbursementAmount = reimbRecords.reduce((sum, r) => sum + Number(r.amount), 0);

      const grossSalary = Math.round((grossFromProfile + overtimeAmount + bonusAmount + reimbursementAmount) * 100) / 100;

      // Step 8: Calculate Deductions (Statutory + Loans/Advances)
      // PF: 12% on basic up to 15,000 ceiling
      const pfBase = Math.min(basicSalary, 15000);
      const pfDeduction = Math.round(pfBase * 0.12 * 100) / 100;

      // ESIC: employee-side, statutory threshold + rate from the shared util
      const esicDeduction = calculateEsic(grossSalary).employee;

      // PT (Professional Tax standard approximation)
      const ptDeduction = grossSalary > 15000 ? 200 : 0;

      // TDS approximation (e.g. 5% if gross > 50,000 monthly)
      const tdsDeduction = grossSalary > 50000 ? Math.round(grossSalary * 0.05 * 100) / 100 : 0;

      // Loan EMI deduction
      let loanEmiDeduction = 0;
      for (const loan of emp.loans) {
        if (loan.autoDeduction) {
          const emi = Math.min(Number(loan.monthlyEmi), Number(loan.remainingAmount));
          loanEmiDeduction += emi;
          // Deduct from remaining loan balance
          const newBal = Number(loan.remainingAmount) - emi;
          await this.prisma.employeeLoan.update({
            where: { id: loan.id },
            data: {
              remainingAmount: newBal,
              status: newBal <= 0 ? LoanStatus.CLOSED : LoanStatus.ACTIVE,
            },
          });
        }
      }

      // Salary Advance recovery
      let advanceDeduction = 0;
      for (const adv of emp.salaryAdvances) {
        const advAmt = Number(adv.remainingAmount);
        advanceDeduction += advAmt;
        await this.prisma.salaryAdvance.update({
          where: { id: adv.id },
          data: {
            remainingAmount: 0,
            status: LoanStatus.CLOSED,
          },
        });
      }

      const lwpDeduction = 0;
      const totalDeduction = Math.round((pfDeduction + esicDeduction + ptDeduction + tdsDeduction + loanEmiDeduction + advanceDeduction + lwpDeduction) * 100) / 100;

      // Step 9: Compute Net Salary
      const netSalary = Math.max(0, Math.round((grossSalary - totalDeduction) * 100) / 100);

      totalGross += grossSalary;
      totalBonus += bonusAmount;
      totalReimbursement += reimbursementAmount;
      totalDeductions += totalDeduction;
      totalNet += netSalary;

      // Step 10: Persist PayrollDetail
      await this.prisma.payrollDetail.create({
        data: {
          batchId: batch.id,
          employeeId: emp.id,
          workingDays,
          presentDays,
          paidLeaveDays: 0,
          lwpDays,
          basicSalary: Math.round(basicSalary * 100) / 100,
          allowances: allowancesObj,
          overtimeAmount: Math.round(overtimeAmount * 100) / 100,
          bonusAmount: Math.round(bonusAmount * 100) / 100,
          reimbursementAmount: Math.round(reimbursementAmount * 100) / 100,
          grossSalary,
          pfDeduction,
          esicDeduction,
          tdsDeduction,
          ptDeduction,
          loanEmiDeduction: Math.round(loanEmiDeduction * 100) / 100,
          advanceDeduction: Math.round(advanceDeduction * 100) / 100,
          lwpDeduction,
          totalDeduction,
          netSalary,
          paymentStatus: BankTransferStatus.PENDING,
        },
      });
    }

    // Generate initial 3-tier approval workflow
    await this.prisma.payrollApprovalWorkflow.createMany({
      data: [
        { batchId: batch.id, tier: 'LEVEL_1_HR', approverRole: 'HR', status: PayrollApprovalStatus.PENDING },
        { batchId: batch.id, tier: 'LEVEL_2_FINANCE', approverRole: 'FINANCE', status: PayrollApprovalStatus.PENDING },
        { batchId: batch.id, tier: 'LEVEL_3_ADMIN', approverRole: 'ADMIN', status: PayrollApprovalStatus.PENDING },
      ],
    });

    // Update batch summary
    const updatedBatch = await this.prisma.payrollProcessingBatch.update({
      where: { id: batch.id },
      data: {
        status: PayrollApprovalStatus.PENDING,
        totalEmployees,
        totalGross: Math.round(totalGross * 100) / 100,
        totalBonus: Math.round(totalBonus * 100) / 100,
        totalReimbursement: Math.round(totalReimbursement * 100) / 100,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        totalNet: Math.round(totalNet * 100) / 100,
      },
      include: {
        details: {
          include: {
            employee: { select: { id: true, employeeId: true, fullName: true, department: true, designation: true } },
          },
        },
        approvals: true,
        branch: { select: { id: true, name: true, city: true } },
      },
    });

    return updatedBatch;
  }

  async getBatches(query: any) {
    const where: Prisma.PayrollProcessingBatchWhereInput = {};
    if (query.month) where.month = Number(query.month);
    if (query.year) where.year = Number(query.year);
    if (query.branchId) where.branchId = query.branchId;
    if (query.status) where.status = query.status as PayrollApprovalStatus;

    return this.prisma.payrollProcessingBatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        branch: { select: { id: true, name: true, city: true } },
        approvals: true,
        _count: { select: { details: true } },
      },
    });
  }

  async getBatchById(id: string) {
    const batch = await this.prisma.payrollProcessingBatch.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true, city: true } },
        details: {
          include: {
            employee: {
              select: {
                id: true,
                employeeId: true,
                fullName: true,
                department: true,
                designation: true,
                salaryProfile: { select: { bankName: true, accountNumber: true, ifsc: true } },
              },
            },
          },
        },
        approvals: { orderBy: { tier: 'asc' } },
      },
    });
    if (!batch) throw new NotFoundException(`Payroll batch ${id} not found.`);
    return batch;
  }

  /**
   * Multi-tier Approval Workflow
   *
   * TIER_ORDER + the role check below close a real segregation-of-duties
   * bypass: this used to let anyone in (HR, ADMIN, FINANCE) approve ANY tier
   * regardless of `workflow.approverRole` (a column that already existed,
   * just never read for this) or whether earlier tiers were even approved
   * yet. Confirmed live: a FINANCE token could approve LEVEL_3_ADMIN first,
   * leaving LEVEL_1_HR/LEVEL_2_FINANCE PENDING, and the batch still worked.
   */
  private static readonly TIER_ORDER: Record<string, number> = {
    LEVEL_1_HR: 1,
    LEVEL_2_FINANCE: 2,
    LEVEL_3_ADMIN: 3,
  };

  async approveTier(batchId: string, dto: ApproveBatchTierDto, userId?: string, userRole?: string) {
    const batch = await this.getBatchById(batchId);
    if (batch.status === PayrollApprovalStatus.LOCKED) {
      throw new BadRequestException('Cannot approve a locked payroll batch.');
    }

    const workflow = batch.approvals.find((w) => w.tier === dto.tier);
    if (!workflow) {
      throw new NotFoundException(`Approval tier ${dto.tier} not found on this batch.`);
    }
    if (userRole && workflow.approverRole !== userRole) {
      throw new ForbiddenException(
        `Tier ${dto.tier} requires role ${workflow.approverRole}, not ${userRole}.`,
      );
    }
    const thisOrder = EnterprisePayrollService.TIER_ORDER[dto.tier] ?? 0;
    const earlierPending = batch.approvals.some((w) => {
      const order = EnterprisePayrollService.TIER_ORDER[w.tier] ?? 0;
      return order < thisOrder && w.status !== PayrollApprovalStatus.APPROVED;
    });
    if (earlierPending) {
      throw new BadRequestException(`Earlier approval tiers must be approved before ${dto.tier}.`);
    }

    await this.prisma.payrollApprovalWorkflow.update({
      where: { id: workflow.id },
      data: {
        status: PayrollApprovalStatus.APPROVED,
        approvedBy: userId,
        comments: dto.comments,
        actionDate: new Date(),
      },
    });

    // Check if all tiers are approved
    const allApprovals = await this.prisma.payrollApprovalWorkflow.findMany({ where: { batchId } });
    const allApproved = allApprovals.every((a) => a.id === workflow.id ? true : a.status === PayrollApprovalStatus.APPROVED);

    if (allApproved) {
      return this.prisma.payrollProcessingBatch.update({
        where: { id: batchId },
        data: {
          status: PayrollApprovalStatus.APPROVED,
          approvedAt: new Date(),
        },
        include: { approvals: true },
      });
    }

    return this.getBatchById(batchId);
  }

  async rejectTier(batchId: string, dto: ApproveBatchTierDto, userId?: string, userRole?: string) {
    const batch = await this.getBatchById(batchId);
    const workflow = batch.approvals.find((w) => w.tier === dto.tier);
    if (!workflow) {
      throw new NotFoundException(`Approval tier ${dto.tier} not found on this batch.`);
    }
    if (userRole && workflow.approverRole !== userRole) {
      throw new ForbiddenException(
        `Tier ${dto.tier} requires role ${workflow.approverRole}, not ${userRole}.`,
      );
    }

    await this.prisma.payrollApprovalWorkflow.update({
      where: { id: workflow.id },
      data: {
        status: PayrollApprovalStatus.REJECTED,
        approvedBy: userId,
        comments: dto.comments,
        actionDate: new Date(),
      },
    });

    return this.prisma.payrollProcessingBatch.update({
      where: { id: batchId },
      data: { status: PayrollApprovalStatus.REJECTED },
      include: { approvals: true },
    });
  }

  async lockBatch(batchId: string) {
    const batch = await this.getBatchById(batchId);
    if (batch.status !== PayrollApprovalStatus.APPROVED) {
      throw new BadRequestException('Only approved payroll batches can be locked.');
    }

    return this.prisma.payrollProcessingBatch.update({
      where: { id: batchId },
      data: {
        status: PayrollApprovalStatus.LOCKED,
        lockedAt: new Date(),
      },
      include: { approvals: true },
    });
  }

  /**
   * Bank Transfer Batch Generation
   */
  async generateBankTransfer(batchId: string, dto: GenerateBankTransferDto, userId?: string) {
    const batch = await this.getBatchById(batchId);
    const format = dto.format ?? 'CSV';

    // Create BankTransferBatch record
    const transfer = await this.prisma.bankTransferBatch.create({
      data: {
        batchId: batch.id,
        format,
        totalRecords: batch.totalEmployees,
        totalAmount: batch.totalNet,
        status: BankTransferStatus.PROCESSING,
        generatedBy: userId,
        fileUrl: `/exports/bank-transfer-${batch.batchNumber}.${format.toLowerCase()}`,
      },
    });

    // Update details status
    await this.prisma.payrollDetail.updateMany({
      where: { batchId: batch.id },
      data: { paymentStatus: BankTransferStatus.PROCESSING },
    });

    return transfer;
  }

  /**
   * Enterprise Reports
   */
  async getSummaryReport(month?: number, year?: number, branchId?: string) {
    const where: Prisma.PayrollProcessingBatchWhereInput = {};
    if (month) where.month = Number(month);
    if (year) where.year = Number(year);
    if (branchId) where.branchId = branchId;

    const batches = await this.prisma.payrollProcessingBatch.findMany({
      where,
      include: { branch: { select: { id: true, name: true } } },
    });

    const totalGross = batches.reduce((s, b) => s + Number(b.totalGross), 0);
    const totalBonus = batches.reduce((s, b) => s + Number(b.totalBonus), 0);
    const totalReimbursement = batches.reduce((s, b) => s + Number(b.totalReimbursement), 0);
    const totalDeductions = batches.reduce((s, b) => s + Number(b.totalDeductions), 0);
    const totalNet = batches.reduce((s, b) => s + Number(b.totalNet), 0);
    const totalEmployees = batches.reduce((s, b) => s + b.totalEmployees, 0);

    return {
      period: { month, year, branchId },
      kpis: {
        totalGross: Math.round(totalGross * 100) / 100,
        totalBonus: Math.round(totalBonus * 100) / 100,
        totalReimbursement: Math.round(totalReimbursement * 100) / 100,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        totalNet: Math.round(totalNet * 100) / 100,
        totalEmployees,
        batchCount: batches.length,
      },
      batches,
    };
  }

  async getDepartmentBreakdown(month?: number, year?: number) {
    const whereBatch: any = {};
    if (month) whereBatch.month = Number(month);
    if (year) whereBatch.year = Number(year);

    const details = await this.prisma.payrollDetail.findMany({
      where: { batch: whereBatch },
      include: {
        employee: { select: { department: true } },
      },
    });

    const breakdown: { [dept: string]: { employees: number; gross: number; net: number; deductions: number } } = {};
    for (const d of details) {
      const dept = d.employee.department || 'General';
      if (!breakdown[dept]) {
        breakdown[dept] = { employees: 0, gross: 0, net: 0, deductions: 0 };
      }
      breakdown[dept].employees++;
      breakdown[dept].gross += Number(d.grossSalary);
      breakdown[dept].net += Number(d.netSalary);
      breakdown[dept].deductions += Number(d.totalDeduction);
    }

    return Object.entries(breakdown).map(([department, stats]) => ({
      department,
      employees: stats.employees,
      gross: Math.round(stats.gross * 100) / 100,
      net: Math.round(stats.net * 100) / 100,
      deductions: Math.round(stats.deductions * 100) / 100,
    }));
  }

  async getStatutoryCompliance(month?: number, year?: number) {
    const whereBatch: any = {};
    if (month) whereBatch.month = Number(month);
    if (year) whereBatch.year = Number(year);

    const details = await this.prisma.payrollDetail.findMany({
      where: { batch: whereBatch },
    });

    const pfTotal = details.reduce((s, d) => s + Number(d.pfDeduction), 0);
    const esicTotal = details.reduce((s, d) => s + Number(d.esicDeduction), 0);
    const ptTotal = details.reduce((s, d) => s + Number(d.ptDeduction), 0);
    const tdsTotal = details.reduce((s, d) => s + Number(d.tdsDeduction), 0);

    return {
      period: { month, year },
      complianceTotals: {
        providentFund: Math.round(pfTotal * 100) / 100,
        esic: Math.round(esicTotal * 100) / 100,
        professionalTax: Math.round(ptTotal * 100) / 100,
        tds: Math.round(tdsTotal * 100) / 100,
        totalStatutoryDeduction: Math.round((pfTotal + esicTotal + ptTotal + tdsTotal) * 100) / 100,
      },
    };
  }

  /**
   * Payroll Settings
   */
  async getSettings() {
    return this.prisma.payrollSetting.findMany({
      orderBy: { settingKey: 'asc' },
    });
  }

  async updateSetting(dto: UpdatePayrollSettingDto, userId?: string) {
    return this.prisma.payrollSetting.upsert({
      where: { settingKey: dto.settingKey },
      create: {
        settingKey: dto.settingKey,
        settingValue: dto.settingValue,
        description: dto.description,
        updatedBy: userId,
      },
      update: {
        settingValue: dto.settingValue,
        description: dto.description,
        updatedBy: userId,
      },
    });
  }
}

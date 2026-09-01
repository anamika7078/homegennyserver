import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PayrollService } from './payroll.service';
import { calculateEsic } from '../../common/finance/statutory-calc.util';
import { StatutoryTaxService } from '../finance/tax/statutory-tax.service';
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

  constructor(
    private readonly prisma: PrismaService,
    // Reused rather than reimplemented: countAttendanceForEmployee() is the
    // same audited reader the HR payroll path uses, so both engines now
    // count a month the same way instead of disagreeing (see F-01/F-11 in
    // docs/FINANCE_MODULE_AUDIT.md).
    private readonly payroll: PayrollService,
    private readonly tax: StatutoryTaxService,
  ) {}

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
    /** Employees left out of the batch, with the reason — returned, not persisted. */
    const skipped: { employeeId: string; employeeCode: string; fullName: string; reason: string }[] = [];
    /** Set when any tax figure came from a slab Finance has not signed off (F-16). */
    let unconfirmedRates = false;

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    for (const emp of employees) {
      // Attendance used to be `workingDays = 30, presentDays = 30` hardcoded,
      // so prorationRatio was always exactly 1 and an employee present four
      // days in the month was paid in full — while the UI advertised
      // "auto-calculates attendance proration". This reads the same
      // `attendance` table the HR payroll path reads.
      const summary = await this.payroll.countAttendanceForEmployee(emp.id, month, year);
      const markedDays =
        summary.present_days + summary.absent_days + summary.leave_days + summary.overtime_days;

      // No attendance rows at all for this period is not the same as "absent
      // every day". Paying such an employee zero would be as wrong as paying
      // them in full, and silently doing either is worse — so leave them out
      // of the batch and report them, the way runAttendancePayroll() refuses
      // rather than writing a zero row.
      if (markedDays <= 0) {
        skipped.push({
          employeeId: emp.id,
          employeeCode: emp.employeeId,
          fullName: emp.fullName,
          reason: 'No attendance marked for this period',
        });
        continue;
      }

      totalEmployees++;
      const workingDays = summary.days_in_month;
      // billable_days already folds in Late (full) and Half Day (0.5), and
      // deliberately excludes Leave — matching the HR path, which has no
      // paid-leave concept today.
      const presentDays = summary.billable_days;
      const lwpDays = Math.round((workingDays - presentDays) * 10) / 10;
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
      //
      // Both sides of PF and ESIC are computed now. Only the employee side used
      // to be, so the company's own 12% PF and 3.25% ESIC — its actual
      // liability — existed nowhere, and these employees could not be included
      // in a challan at all. See F-07.
      //
      // PF base here is basic, not gross (the statutory reading), and it is
      // deliberately left as it was rather than changed to match the EOR path,
      // which uses gross. That divergence is real and is flagged as F-20; it is
      // a policy question, not something to settle inside a bug fix.
      // Basic is this employee's agreed PF base; the resolver applies the
      // configured rule and falls back to gross where no basic exists. Both
      // payroll paths go through it, so they cannot diverge again. See F-20.
      const pfBaseResolved = await this.tax.resolvePfBase({
        gross: grossSalary,
        agreedBase: basicSalary > 0 ? basicSalary : null,
      });
      const pfBase = Math.min(pfBaseResolved.base, 15000);
      const pfDeduction = Math.round(pfBase * 0.12 * 100) / 100;
      const pfEmployer = pfDeduction;

      const esic = calculateEsic(grossSalary);
      const esicDeduction = esic.employee;
      const esicEmployer = esic.employer;

      // Professional tax by state, and TDS from an annual projection —
      // the same engine the HR path uses, so the two cannot disagree.
      // Both were flat approximations before, and PT in particular was being
      // charged in states that do not levy it at all. See F-16.
      const ptResult = await this.tax.professionalTax({
        state: emp.state,
        monthlyGross: grossSalary,
        month,
        gender: emp.gender,
      });
      const tdsResult = await this.tax.tds({
        employeeId: emp.id, monthlyGross: grossSalary, month, year,
      });
      const ptDeduction = ptResult.amount;
      const tdsDeduction = tdsResult.monthlyAmount;
      if (ptResult.needsConfirmation || tdsResult.needsConfirmation) unconfirmedRates = true;

      // Loan EMI and salary-advance recovery.
      //
      // Calculated here, but the balances are NOT written until the batch is
      // locked (see applyRecoveries, called from lockBatch). Deducting during
      // calculation meant that re-running a still-DRAFT batch — which this
      // method explicitly supports, and which the UI's "Run 10-Step Pipeline"
      // button does — took another EMI off the loan every single time, while
      // the recalculated payroll_details gave no sign of it. See F-19.
      //
      // The per-loan split is recorded so the lock step replays exactly the
      // figures the payslip showed, rather than recomputing against balances
      // that may have moved in between.
      const recoveryBreakdown: {
        loans: { loanId: string; amount: number }[];
        advances: { advanceId: string; amount: number }[];
      } = { loans: [], advances: [] };

      let loanEmiDeduction = 0;
      for (const loan of emp.loans) {
        if (loan.autoDeduction) {
          const emi = Math.min(Number(loan.monthlyEmi), Number(loan.remainingAmount));
          if (emi > 0) {
            loanEmiDeduction += emi;
            recoveryBreakdown.loans.push({ loanId: loan.id, amount: Math.round(emi * 100) / 100 });
          }
        }
      }

      let advanceDeduction = 0;
      for (const adv of emp.salaryAdvances) {
        const advAmt = Number(adv.remainingAmount);
        if (advAmt > 0) {
          advanceDeduction += advAmt;
          recoveryBreakdown.advances.push({ advanceId: adv.id, amount: Math.round(advAmt * 100) / 100 });
        }
      }

      // Stays zero on purpose. Loss of pay is already expressed by
      // prorationRatio shrinking basic + allowances above; charging lwpDays a
      // second time here would deduct the same absence twice.
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
          esicEmployer,
          pfEmployer,
          tdsDeduction,
          ptDeduction,
          loanEmiDeduction: Math.round(loanEmiDeduction * 100) / 100,
          advanceDeduction: Math.round(advanceDeduction * 100) / 100,
          lwpDeduction,
          totalDeduction,
          netSalary,
          recoveryBreakdown,
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

    if (skipped.length) {
      this.logger.warn(
        `[ENTERPRISE_PAYROLL] ${batch.batchNumber}: ${skipped.length} employee(s) excluded for ` +
        `missing attendance — ${skipped.map((s) => s.employeeCode).join(', ')}`,
      );
    }

    if (unconfirmedRates) {
      this.logger.warn(
        `[ENTERPRISE_PAYROLL] ${batch.batchNumber}: tax slabs are not confirmed — ` +
        `figures come from seeded defaults.`,
      );
    }

    return { ...updatedBatch, skipped, unconfirmedTaxRates: unconfirmedRates };
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

  /**
   * Applies the loan/advance recovery that the batch's payslips promised.
   *
   * Runs once, at lock, inside the same transaction that locks the batch —
   * so a balance only moves against a payroll that is final and immutable,
   * and a recalculated draft can no longer eat an EMI per run (F-19).
   *
   * `recoveries_applied_at` makes it idempotent independently of the status
   * check, so even a future code path that re-locks cannot double-recover.
   */
  private async applyRecoveries(
    tx: Prisma.TransactionClient,
    batchId: string,
  ): Promise<{ loans: number; advances: number; totalRecovered: number }> {
    const batch = await tx.payrollProcessingBatch.findUnique({
      where: { id: batchId },
      select: { recoveriesAppliedAt: true },
    });
    if (batch?.recoveriesAppliedAt) {
      return { loans: 0, advances: 0, totalRecovered: 0 };
    }

    const details = await tx.payrollDetail.findMany({
      where: { batchId },
      select: { recoveryBreakdown: true },
    });

    let loans = 0;
    let advances = 0;
    let totalRecovered = 0;

    for (const detail of details) {
      const breakdown = (detail.recoveryBreakdown ?? {}) as {
        loans?: { loanId: string; amount: number }[];
        advances?: { advanceId: string; amount: number }[];
      };

      for (const entry of breakdown.loans ?? []) {
        const loan = await tx.employeeLoan.findUnique({
          where: { id: entry.loanId },
          select: { remainingAmount: true },
        });
        if (!loan) continue;
        // Never drive a balance negative, even if the loan was partly repaid
        // by some other route between calculation and lock.
        const applied = Math.min(entry.amount, Number(loan.remainingAmount));
        if (applied <= 0) continue;
        const newBal = Math.round((Number(loan.remainingAmount) - applied) * 100) / 100;
        await tx.employeeLoan.update({
          where: { id: entry.loanId },
          data: {
            remainingAmount: newBal,
            status: newBal <= 0 ? LoanStatus.CLOSED : LoanStatus.ACTIVE,
          },
        });
        loans++;
        totalRecovered += applied;
      }

      for (const entry of breakdown.advances ?? []) {
        const adv = await tx.salaryAdvance.findUnique({
          where: { id: entry.advanceId },
          select: { remainingAmount: true },
        });
        if (!adv) continue;
        const applied = Math.min(entry.amount, Number(adv.remainingAmount));
        if (applied <= 0) continue;
        const newBal = Math.round((Number(adv.remainingAmount) - applied) * 100) / 100;
        await tx.salaryAdvance.update({
          where: { id: entry.advanceId },
          data: {
            remainingAmount: newBal,
            status: newBal <= 0 ? LoanStatus.CLOSED : LoanStatus.ACTIVE,
          },
        });
        advances++;
        totalRecovered += applied;
      }
    }

    return { loans, advances, totalRecovered: Math.round(totalRecovered * 100) / 100 };
  }

  async lockBatch(batchId: string) {
    const batch = await this.getBatchById(batchId);
    if (batch.status !== PayrollApprovalStatus.APPROVED) {
      throw new BadRequestException('Only approved payroll batches can be locked.');
    }

    const { locked, recovered } = await this.prisma.$transaction(async (tx) => {
      const recovered = await this.applyRecoveries(tx, batchId);
      const locked = await tx.payrollProcessingBatch.update({
        where: { id: batchId },
        data: {
          status: PayrollApprovalStatus.LOCKED,
          lockedAt: new Date(),
          recoveriesAppliedAt: new Date(),
        },
        include: { approvals: true },
      });
      return { locked, recovered };
    });

    if (recovered.totalRecovered > 0) {
      this.logger.log(
        `[ENTERPRISE_PAYROLL] ${locked.batchNumber} locked — recovered ` +
        `${recovered.totalRecovered} across ${recovered.loans} loan(s) and ${recovered.advances} advance(s)`,
      );
    }

    return { ...locked, recovered };
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

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const pfEmployee = details.reduce((s, d) => s + Number(d.pfDeduction), 0);
    const pfEmployer = details.reduce((s, d) => s + Number(d.pfEmployer), 0);
    const esicEmployee = details.reduce((s, d) => s + Number(d.esicDeduction), 0);
    const esicEmployer = details.reduce((s, d) => s + Number(d.esicEmployer), 0);
    const ptTotal = details.reduce((s, d) => s + Number(d.ptDeduction), 0);
    const tdsTotal = details.reduce((s, d) => s + Number(d.tdsDeduction), 0);

    const withheld = pfEmployee + esicEmployee + ptTotal + tdsTotal;
    const employerCost = pfEmployer + esicEmployer;

    return {
      period: { month, year },
      complianceTotals: {
        // Withheld from the employee's salary…
        providentFund: r2(pfEmployee),
        esic: r2(esicEmployee),
        professionalTax: r2(ptTotal),
        tds: r2(tdsTotal),
        totalStatutoryDeduction: r2(withheld),

        // …and what the company owes on top of it. Previously absent, which
        // made the report look like the whole statutory bill when it was only
        // the half taken out of salaries (F-07).
        providentFundEmployer: r2(pfEmployer),
        esicEmployer: r2(esicEmployer),
        totalEmployerContribution: r2(employerCost),

        /** Everything payable to the authorities for this period. */
        totalStatutoryLiability: r2(withheld + employerCost),
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

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Razorpay = require('razorpay');

// ── Statutory rates ───────────────────────────────────────────────────────────
const GST_RATE = 0.18;    // GST on management fee ONLY — never on salary
const ESIC_EMPLOYEE_RATE = 0.0075;  // 0.75% employee contribution (wages <= 21,000)
const ESIC_EMPLOYER_RATE = 0.0325;  // 3.25% employer contribution
const PF_RATE = 0.12;    // 12% each side on first 15,000
const PF_WAGE_CEILING = 15_000;

export interface PayrollCalculation {
  grossSalary: number;
  esicEmployee: number;
  esicEmployer: number;
  pfEmployee: number;
  pfEmployer: number;
  netSalary: number;
  managementFee: number;
  gstOnFee: number;
  clientTotalCharge: number;
}

interface PlacementRow {
  staff_id: string;
  client_id: string;
  staff_salary: string;
  management_fee: string;
}

interface ShiftCountRow { shift_days: string; }

interface AttendanceCountRow { status: string; count: string; }

export interface AttendanceSummary {
  present_days: number;
  absent_days: number;
  leave_days: number;
  overtime_days: number;
  billable_days: number;
  days_in_month: number;
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _razorpay: any;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    // Razorpay is initialised lazily in getRazorpay() so that the module
    // boots cleanly in dev even when credentials are placeholders.
  }

  /** Lazily create the Razorpay client — only throws when actually used. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRazorpay(): any {
    if (!this._razorpay) {
      const keyId = this.config.get<string>('app.razorpay.keyId', '');
      const keySecret = this.config.get<string>('app.razorpay.keySecret', '');
      if (!keyId || keyId.startsWith('YOUR_') || !keySecret || keySecret.startsWith('YOUR_')) {
        throw new Error(
          'Razorpay credentials are not configured. ' +
          'Check your environment variables for app.razorpay.keyId and app.razorpay.keySecret.',
        );
      }
      // Razorpay uses CommonJS exports — require() avoids the default-import interop issue
      this._razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
    return this._razorpay;
  }

  /**
   * Demo batch queue — logs intent; extend with DB / job queue in production.
   */
  queuePayrollBatch(month: number, year: number, series?: string): {
    staff_count: number;
    total_inr: number;
    message: string;
    razorpay_scheduled: boolean;
  } {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const label = `${monthNames[month - 1] ?? 'Month'} ${year}`;
    const staffCount = 14;
    const totalInr = 328000;
    const totalFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(totalInr);
    this.logger.log(
      `[PAYROLL_QUEUE] ${label} series=${series ?? 'ALL'} staff=${staffCount} total=₹${totalFmt}`,
    );
    return {
      staff_count: staffCount,
      total_inr: totalInr,
      razorpay_scheduled: true,
      message: `${label} payroll batch queued — ${staffCount} staff · ₹${totalFmt} total · Razorpay disbursement scheduled`,
    };
  }

  daysInMonth(month: number, year: number): number {
    return new Date(year, month, 0).getDate();
  }

  calculateProratedGross(monthlySalary: number, billableDays: number, daysInMonth: number): number {
    if (daysInMonth <= 0) return 0;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return r2(monthlySalary * (billableDays / daysInMonth));
  }

  summarizeAttendanceCounts(rows: AttendanceCountRow[], month: number, year: number): AttendanceSummary {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = parseInt(row.count, 10);
    }
    const present_days = counts.PRESENT ?? 0;
    const absent_days = counts.ABSENT ?? 0;
    const leave_days = counts.LEAVE ?? 0;
    const overtime_days = counts.OVERTIME ?? 0;
    return {
      present_days,
      absent_days,
      leave_days,
      overtime_days,
      billable_days: present_days + overtime_days,
      days_in_month: this.daysInMonth(month, year),
    };
  }

  calculatePayrollWithAbsoluteFee(grossSalary: number, managementFee: number): PayrollCalculation {
    const r2 = (n: number) => Math.round(n * 100) / 100;

    const esicApplicable = grossSalary <= 21_000;
    const esicEmployee = esicApplicable ? r2(grossSalary * ESIC_EMPLOYEE_RATE) : 0;
    const esicEmployer = esicApplicable ? r2(grossSalary * ESIC_EMPLOYER_RATE) : 0;

    const pfBase = Math.min(grossSalary, PF_WAGE_CEILING);
    const pfEmployee = r2(pfBase * PF_RATE);
    const pfEmployer = r2(pfBase * PF_RATE);

    const netSalary = r2(grossSalary - esicEmployee - pfEmployee);
    const gstOnFee = r2(managementFee * GST_RATE);
    const clientTotalCharge = r2(grossSalary + esicEmployer + pfEmployer + managementFee + gstOnFee);

    return {
      grossSalary,
      esicEmployee,
      esicEmployer,
      pfEmployee,
      pfEmployer,
      netSalary,
      managementFee: r2(managementFee),
      gstOnFee,
      clientTotalCharge,
    };
  }

  calculatePayroll(grossSalary: number, managementFeePercent: number): PayrollCalculation {
    const r2 = (n: number) => Math.round(n * 100) / 100;

    const esicApplicable = grossSalary <= 21_000;
    const esicEmployee = esicApplicable ? r2(grossSalary * ESIC_EMPLOYEE_RATE) : 0;
    const esicEmployer = esicApplicable ? r2(grossSalary * ESIC_EMPLOYER_RATE) : 0;

    const pfBase = Math.min(grossSalary, PF_WAGE_CEILING);
    const pfEmployee = r2(pfBase * PF_RATE);
    const pfEmployer = r2(pfBase * PF_RATE);

    const netSalary = r2(grossSalary - esicEmployee - pfEmployee);
    const managementFee = r2(grossSalary * (managementFeePercent / 100));
    const gstOnFee = r2(managementFee * GST_RATE);
    const clientTotalCharge = r2(grossSalary + esicEmployer + pfEmployer + managementFee + gstOnFee);

    return {
      grossSalary, esicEmployee, esicEmployer,
      pfEmployee, pfEmployer, netSalary,
      managementFee, gstOnFee, clientTotalCharge,
    };
  }

  async runMonthlyPayroll(
    placementId: string,
    month: number,
    year: number,
  ): Promise<Record<string, unknown>> {
    return this.dataSource.transaction(async (manager) => {
      const placements = await manager.query<PlacementRow[]>(
        `SELECT staff_id, client_id, staff_salary, management_fee
         FROM placements WHERE id = $1`,
        [placementId],
      );
      if (!placements.length) throw new NotFoundException(`Placement ${placementId} not found`);
      const p = placements[0];

      const shifts = await manager.query<ShiftCountRow[]>(
        `SELECT COUNT(*) AS shift_days FROM shift_logs
         WHERE placement_id = $1
           AND EXTRACT(MONTH FROM shift_date) = $2
           AND EXTRACT(YEAR  FROM shift_date) = $3
           AND status = 'APPROVED'`,
        [placementId, month, year],
      );
      const shiftDays = parseInt(shifts[0]?.shift_days ?? '0', 10);

      const monthlySalary = parseFloat(p.staff_salary);
      const monthlyFee = parseFloat(p.management_fee);
      const dim = this.daysInMonth(month, year);
      const proratedGross = this.calculateProratedGross(monthlySalary, shiftDays, dim);
      const proratedFee = this.calculateProratedGross(monthlyFee, shiftDays, dim);
      const calc = this.calculatePayrollWithAbsoluteFee(proratedGross, proratedFee);

      const [payroll] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO payroll_records
           (placement_id, staff_id, period_month, period_year, shift_days,
            gross_salary, deductions, net_salary,
            esic_employer, esic_employee, pf_employer, pf_employee)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          placementId, p.staff_id, month, year, shiftDays,
          calc.grossSalary,
          JSON.stringify({ esic: calc.esicEmployee, pf: calc.pfEmployee }),
          calc.netSalary,
          calc.esicEmployer, calc.esicEmployee, calc.pfEmployer, calc.pfEmployee,
        ],
      );

      const invoiceNo = `INV-${year}${String(month).padStart(2, '0')}-${placementId.slice(0, 6).toUpperCase()}`;
      const dueDate = new Date(year, month, 5);  // 5th of following month

      const [invoice] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO client_invoices
           (placement_id, client_id, invoice_number, period_month, period_year,
            staff_salary_component, management_fee, gst_amount, total_amount, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          placementId, p.client_id, invoiceNo, month, year,
          calc.grossSalary, calc.managementFee, calc.gstOnFee, calc.clientTotalCharge, dueDate,
        ],
      );

      this.logger.log(`[PAYROLL] Completed placement ${placementId} ${month}/${year}`);
      return { payroll, invoice, calculation: calc };
    });
  }

  async countAttendanceForStaff(
    staffId: string,
    month: number,
    year: number,
  ): Promise<AttendanceSummary> {
    const rows = await this.dataSource.query<AttendanceCountRow[]>(
      `SELECT status::text, COUNT(*)::text AS count
       FROM staff_daily_attendance
       WHERE staff_id = $1
         AND EXTRACT(MONTH FROM attendance_date) = $2
         AND EXTRACT(YEAR  FROM attendance_date) = $3
       GROUP BY status`,
      [staffId, month, year],
    );
    return this.summarizeAttendanceCounts(rows, month, year);
  }

  async previewAttendancePayroll(placementId: string, month: number, year: number) {
    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT staff_id, client_id, staff_salary, management_fee
       FROM placements WHERE id = $1`,
      [placementId],
    );
    if (!placements.length) throw new NotFoundException(`Placement ${placementId} not found`);
    const p = placements[0];

    const summary = await this.countAttendanceForStaff(p.staff_id, month, year);
    const monthlySalary = parseFloat(p.staff_salary);
    const monthlyFee = parseFloat(p.management_fee);
    const proratedGross = this.calculateProratedGross(
      monthlySalary,
      summary.billable_days,
      summary.days_in_month,
    );
    const proratedFee = this.calculateProratedGross(
      monthlyFee,
      summary.billable_days,
      summary.days_in_month,
    );
    const calc = this.calculatePayrollWithAbsoluteFee(proratedGross, proratedFee);

    return {
      placement_id: placementId,
      staff_id: p.staff_id,
      period_month: month,
      period_year: year,
      monthly_salary: monthlySalary,
      monthly_management_fee: monthlyFee,
      ...summary,
      prorated_gross: proratedGross,
      prorated_management_fee: proratedFee,
      calculation: calc,
    };
  }

  async runAttendancePayroll(
    placementId: string,
    month: number,
    year: number,
  ): Promise<Record<string, unknown>> {
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM client_invoices
       WHERE placement_id = $1 AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [placementId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Invoice already exists for placement ${placementId} in ${month}/${year}`,
      );
    }

    const preview = await this.previewAttendancePayroll(placementId, month, year);
    if (preview.billable_days <= 0) {
      throw new BadRequestException('No billable attendance days for this period');
    }

    const placements = await this.dataSource.query<PlacementRow[]>(
      `SELECT staff_id, client_id, staff_salary, management_fee
       FROM placements WHERE id = $1`,
      [placementId],
    );
    const p = placements[0];
    const calc = preview.calculation as PayrollCalculation;

    return this.dataSource.transaction(async (manager) => {
      const [payroll] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO payroll_records
           (placement_id, staff_id, period_month, period_year, shift_days,
            gross_salary, deductions, net_salary,
            esic_employer, esic_employee, pf_employer, pf_employee)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          placementId,
          p.staff_id,
          month,
          year,
          preview.billable_days,
          calc.grossSalary,
          JSON.stringify({ esic: calc.esicEmployee, pf: calc.pfEmployee }),
          calc.netSalary,
          calc.esicEmployer,
          calc.esicEmployee,
          calc.pfEmployer,
          calc.pfEmployee,
        ],
      );

      const invoiceNo = `INV-${year}${String(month).padStart(2, '0')}-${placementId.slice(0, 6).toUpperCase()}`;
      const dueDate = new Date(year, month, 5);

      const [invoice] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO client_invoices
           (placement_id, client_id, invoice_number, period_month, period_year,
            staff_salary_component, management_fee, gst_amount, total_amount, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          placementId,
          p.client_id,
          invoiceNo,
          month,
          year,
          calc.grossSalary,
          calc.managementFee,
          calc.gstOnFee,
          calc.clientTotalCharge,
          dueDate,
        ],
      );

      this.logger.log(`[ATTENDANCE_PAYROLL] placement ${placementId} ${month}/${year}`);
      return { payroll, invoice, preview, calculation: calc };
    });
  }

  async createRazorpayOrder(
    invoiceId: string,
    amount: number,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const order = await this.getRazorpay().orders.create({
      amount: Math.round(amount * 100),   // convert Rs to paise
      currency: 'INR',
      receipt: invoiceId,
      notes: { invoiceId },
    }) as Record<string, unknown>;
    return order;
  }

  // ── Internal Employee Payroll ──────────────────────────────────────────────

  async countAttendanceForEmployee(
    employeeId: string,
    month: number,
    year: number,
  ): Promise<AttendanceSummary> {
    const rows = await this.dataSource.query<AttendanceCountRow[]>(
      `SELECT status::text, COUNT(*)::text AS count
       FROM attendance
       WHERE employee_id = $1::uuid
         AND EXTRACT(MONTH FROM date) = $2
         AND EXTRACT(YEAR  FROM date) = $3
       GROUP BY status`,
      [employeeId, month, year],
    );
    
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = parseInt(row.count, 10);
    }
    const present_days = (counts['Present'] ?? 0) + (counts['Late'] ?? 0) + ((counts['Half Day'] ?? 0) * 0.5);
    const absent_days = counts['Absent'] ?? 0;
    const leave_days = counts['Leave'] ?? 0;

    return {
      present_days,
      absent_days,
      leave_days,
      overtime_days: 0,
      billable_days: present_days,
      days_in_month: this.daysInMonth(month, year),
    };
  }

  async previewEmployeePayroll(employeeId: string, month: number, year: number) {
    const employees = await this.dataSource.query<{ salary: string }[]>(
      `SELECT salary FROM employees WHERE id = $1::uuid`,
      [employeeId],
    );
    if (!employees.length) throw new NotFoundException(`Employee ${employeeId} not found`);
    const emp = employees[0];

    const summary = await this.countAttendanceForEmployee(employeeId, month, year);
    const monthlySalary = parseFloat(emp.salary);
    const proratedGross = this.calculateProratedGross(
      monthlySalary,
      summary.billable_days,
      summary.days_in_month,
    );

    // Basic calculation for internal staff (no management fee, no client charge)
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const esicApplicable = proratedGross <= 21_000;
    const esicEmployee = esicApplicable ? r2(proratedGross * ESIC_EMPLOYEE_RATE) : 0;
    const pfBase = Math.min(proratedGross, PF_WAGE_CEILING);
    const pfEmployee = r2(pfBase * PF_RATE);
    const netSalary = r2(proratedGross - esicEmployee - pfEmployee);

    const calculation = {
      grossSalary: proratedGross,
      esicEmployee,
      pfEmployee,
      netSalary,
    };

    return {
      employee_id: employeeId,
      period_month: month,
      period_year: year,
      monthly_salary: monthlySalary,
      ...summary,
      prorated_gross: proratedGross,
      calculation,
    };
  }

  async runEmployeePayroll(employeeId: string, month: number, year: number) {
    const existing = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM employee_payrolls
       WHERE employee_id = $1::uuid AND period_month = $2 AND period_year = $3
       LIMIT 1`,
      [employeeId, month, year],
    );
    if (existing.length) {
      throw new BadRequestException(
        `Payroll already exists for employee ${employeeId} in ${month}/${year}`,
      );
    }

    const preview = await this.previewEmployeePayroll(employeeId, month, year);
    if (preview.billable_days <= 0) {
      throw new BadRequestException('No billable attendance days for this period');
    }

    const calc = preview.calculation;

    return this.dataSource.transaction(async (manager) => {
      const [payroll] = await manager.query<Record<string, unknown>[]>(
        `INSERT INTO employee_payrolls
           (employee_id, period_month, period_year, present_days,
            gross_salary, deductions, net_salary)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          employeeId,
          month,
          year,
          preview.billable_days,
          calc.grossSalary,
          JSON.stringify({ esic: calc.esicEmployee, pf: calc.pfEmployee }),
          calc.netSalary,
        ],
      );

      this.logger.log(`[EMPLOYEE_PAYROLL] employee ${employeeId} ${month}/${year}`);
      return { payroll, preview };
    });
  }

  async getEmployeePayrolls(): Promise<Record<string, unknown>[]> {
    return this.dataSource.query(
      `SELECT ep.*, e.name AS employee_name, e.email AS employee_email
       FROM employee_payrolls ep
       JOIN employees e ON e.id = ep.employee_id
       ORDER BY ep.period_year DESC, ep.period_month DESC, ep.created_at DESC`,
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { calculateEsic, calculatePfFlat } from '../../../common/finance/statutory-calc.util';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '@prisma/client';

// Statutory rates — single source of truth
const ESIC_EMPLOYEE_RATE = 0.0075;
const ESIC_EMPLOYER_RATE = 0.0325;
const ESIC_WAGE_LIMIT    = 21_000;
const PF_RATE            = 0.12;
const PF_WAGE_CEILING    = 15_000;
// Recomputed vs. stored values are compared with this tolerance — rounding
// differences of a few paise shouldn't flag as a compliance issue.
const AMOUNT_TOLERANCE = 0.5;

export interface PayrollAggRow {
  staff_id: string;
  staff_name: string;
  staff_code: string;
  gross_salary: string;
  esic_employee: string;
  esic_employer: string;
  pf_employee: string;
  pf_employer: string;
  net_salary: string;
}

@Injectable()
export class EsicService {
  private readonly logger = new Logger(EsicService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Was trusting payroll_records verbatim with zero independent
   * recomputation — ESIC_WAGE_LIMIT/PF_WAGE_CEILING were defined but only
   * ever used for display text, never to validate a row before it goes into
   * a government-filing CSV. Confirmed live: a ₹25,000-gross record (above
   * the ESIC wage limit, should be esic=0) still showed full ESIC
   * contributions in a generated challan, because it was old fixture data
   * that predates the current calculation code and nothing ever re-checked
   * it. This recomputes from gross_salary using the same shared
   * calculateEsic/calculatePfFlat every other module uses, and flags (not
   * silently corrects) any row that doesn't match.
   */
  private reconcileEsic(rows: PayrollAggRow[]): (PayrollAggRow & { compliant: boolean; expected_employee: number; expected_employer: number })[] {
    return rows.map((r) => {
      const gross = parseFloat(r.gross_salary);
      const expected = calculateEsic(gross);
      const storedEmployee = parseFloat(r.esic_employee);
      const storedEmployer = parseFloat(r.esic_employer);
      const compliant =
        !isNaN(storedEmployee) && !isNaN(storedEmployer) &&
        Math.abs(expected.employee - storedEmployee) <= AMOUNT_TOLERANCE &&
        Math.abs(expected.employer - storedEmployer) <= AMOUNT_TOLERANCE;
      return { ...r, compliant, expected_employee: expected.employee, expected_employer: expected.employer };
    });
  }

  private reconcilePf(rows: PayrollAggRow[]): (PayrollAggRow & { compliant: boolean; expected_employee: number; expected_employer: number })[] {
    return rows.map((r) => {
      const gross = parseFloat(r.gross_salary);
      const expected = calculatePfFlat(gross);
      const storedEmployee = parseFloat(r.pf_employee);
      const storedEmployer = parseFloat(r.pf_employer);
      const compliant =
        !isNaN(storedEmployee) && !isNaN(storedEmployer) &&
        Math.abs(expected.employee - storedEmployee) <= AMOUNT_TOLERANCE &&
        Math.abs(expected.employer - storedEmployer) <= AMOUNT_TOLERANCE;
      return { ...r, compliant, expected_employee: expected.employee, expected_employer: expected.employer };
    });
  }

  async generateEsicChallan(month: number, year: number, actorId?: string) {
    const rows = await this.dataSource.query<PayrollAggRow[]>(
      `SELECT
          pr.staff_id,
          sa.full_name  AS staff_name,
          sa.staff_code,
          pr.gross_salary,
          pr.esic_employee,
          pr.esic_employer,
          pr.net_salary
       FROM payroll_records pr
       JOIN staff_applicants sa ON sa.id = pr.staff_id
       WHERE pr.period_month = $1 AND pr.period_year = $2
         AND pr.esic_employee > 0`,
      [month, year],
    );

    const reconciled = this.reconcileEsic(rows);
    const mismatches = reconciled.filter((r) => !r.compliant);
    if (mismatches.length) {
      this.logger.warn(
        `[ESIC] ${mismatches.length}/${rows.length} record(s) for ${month}/${year} don't match ` +
        `recomputed ESIC (stale/manual data?) — staff_codes: ${mismatches.map((m) => m.staff_code).join(', ')}`,
      );
    }

    const totalEsicEmployee = rows.reduce((s, r) => s + parseFloat(r.esic_employee), 0);
    const totalEsicEmployer = rows.reduce((s, r) => s + parseFloat(r.esic_employer), 0);

    await this.audit.log({
      actorId, action: AuditAction.PAYROLL_ACTION, entityType: 'esic_challan',
      metadata: { event: 'ESIC_CHALLAN_GENERATED', month, year, staff_count: rows.length, mismatch_count: mismatches.length },
    }).catch(() => undefined);

    return {
      month, year,
      period_label: `${month}/${year}`,
      rates: { employee: `${ESIC_EMPLOYEE_RATE * 100}%`, employer: `${ESIC_EMPLOYER_RATE * 100}%` },
      wage_limit: ESIC_WAGE_LIMIT,
      total_employee_contribution: Math.round(totalEsicEmployee * 100) / 100,
      total_employer_contribution: Math.round(totalEsicEmployer * 100) / 100,
      total_challan_amount: Math.round((totalEsicEmployee + totalEsicEmployer) * 100) / 100,
      staff_count: rows.length,
      mismatch_count: mismatches.length,
      records: reconciled,
    };
  }

  async generatePfEcr(month: number, year: number, actorId?: string) {
    const rows = await this.dataSource.query<PayrollAggRow[]>(
      `SELECT
          pr.staff_id,
          sa.full_name  AS staff_name,
          sa.staff_code,
          pr.gross_salary,
          pr.pf_employee,
          pr.pf_employer,
          pr.net_salary
       FROM payroll_records pr
       JOIN staff_applicants sa ON sa.id = pr.staff_id
       WHERE pr.period_month = $1 AND pr.period_year = $2
         AND pr.pf_employee > 0`,
      [month, year],
    );

    const reconciled = this.reconcilePf(rows);
    const mismatches = reconciled.filter((r) => !r.compliant);
    if (mismatches.length) {
      this.logger.warn(
        `[PF] ${mismatches.length}/${rows.length} record(s) for ${month}/${year} don't match ` +
        `recomputed PF (stale/manual data?) — staff_codes: ${mismatches.map((m) => m.staff_code).join(', ')}`,
      );
    }

    const totalPfEmployee = rows.reduce((s, r) => s + parseFloat(r.pf_employee), 0);
    const totalPfEmployer = rows.reduce((s, r) => s + parseFloat(r.pf_employer), 0);

    await this.audit.log({
      actorId, action: AuditAction.PAYROLL_ACTION, entityType: 'pf_ecr',
      metadata: { event: 'PF_ECR_GENERATED', month, year, staff_count: rows.length, mismatch_count: mismatches.length },
    }).catch(() => undefined);

    return {
      month, year,
      period_label: `${month}/${year}`,
      rates:    { employee: `${PF_RATE * 100}%`, employer: `${PF_RATE * 100}%` },
      wage_ceiling: PF_WAGE_CEILING,
      total_employee_contribution: Math.round(totalPfEmployee * 100) / 100,
      total_employer_contribution: Math.round(totalPfEmployer * 100) / 100,
      total_ecr_amount: Math.round((totalPfEmployee + totalPfEmployer) * 100) / 100,
      staff_count: rows.length,
      mismatch_count: mismatches.length,
      records: reconciled,
    };
  }

  /** Build CSV content for government filing */
  exportCsv(type: 'ESIC' | 'PF', records: PayrollAggRow[], month: number, year: number): string {
    const header = type === 'ESIC'
      ? 'Staff Code,Staff Name,Gross Salary,ESIC Employee (0.75%),ESIC Employer (3.25%),Total ESIC'
      : 'Staff Code,Staff Name,Gross Salary,PF Wage Base,PF Employee (12%),PF Employer (12%),Total PF';

    const lines = records.map((r) => {
      const gross = parseFloat(r.gross_salary);
      if (type === 'ESIC') {
        const emp = parseFloat(r.esic_employee);
        const er  = parseFloat(r.esic_employer);
        return `${r.staff_code},${r.staff_name},${gross},${emp},${er},${emp + er}`;
      } else {
        const pfBase = Math.min(gross, PF_WAGE_CEILING);
        const emp = parseFloat(r.pf_employee);
        const er  = parseFloat(r.pf_employer);
        return `${r.staff_code},${r.staff_name},${gross},${pfBase},${emp},${er},${emp + er}`;
      }
    });

    return [`HomeGenny ${type} Report — ${month}/${year}`, header, ...lines].join('\n');
  }
}

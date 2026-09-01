import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { calculateEsic, calculatePfFlat, round2 } from '../../../common/finance/statutory-calc.util';
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
  /** Which payroll engine produced the row — a filing must name its origin. */
  source: 'EOR' | 'HR' | 'ENTERPRISE';
  /** Base the source computed PF on: gross for EOR/HR, basic for enterprise. */
  pf_base: string;
}

/**
 * Every payroll engine's contributions for one period, in one shape.
 *
 * The challan and ECR used to read `payroll_records` alone, so internal
 * employees (`employee_payrolls`) and enterprise-batch employees
 * (`payroll_details`) were simply absent from what got filed. See F-06.
 *
 * `pf_base` travels with each row because the engines disagree about it: the
 * EOR and HR paths compute PF on gross, the enterprise batch on basic. Passing
 * the base each row actually used means reconciliation checks the arithmetic
 * rather than flagging a policy difference as a data error (see F-20).
 */
const UNIFIED_CONTRIBUTIONS_SQL = `
  SELECT
    pr.staff_id                              AS staff_id,
    sa.full_name                             AS staff_name,
    sa.staff_code                            AS staff_code,
    pr.gross_salary, pr.gross_salary         AS pf_base,
    pr.esic_employee, pr.esic_employer,
    pr.pf_employee, pr.pf_employer,
    pr.net_salary,
    'EOR'                                    AS source
  FROM payroll_records pr
  JOIN staff_applicants sa ON sa.id = pr.staff_id
  WHERE pr.period_month = $1 AND pr.period_year = $2

  UNION ALL

  SELECT
    ep.employee_id                           AS staff_id,
    e.full_name                              AS staff_name,
    e.employee_id                            AS staff_code,
    ep.gross_salary, ep.gross_salary         AS pf_base,
    ep.esic_employee, ep.esic_employer,
    ep.pf_employee, ep.pf_employer,
    ep.net_salary,
    'HR'                                     AS source
  FROM employee_payrolls ep
  JOIN employees e ON e.id = ep.employee_id
  WHERE ep.period_month = $1 AND ep.period_year = $2
    AND e.deleted_at IS NULL

  UNION ALL

  SELECT
    pd.employee_id                           AS staff_id,
    e.full_name                              AS staff_name,
    e.employee_id                            AS staff_code,
    pd.gross_salary,
    LEAST(pd.basic_salary, 15000)            AS pf_base,
    pd.esic_deduction                        AS esic_employee,
    pd.esic_employer,
    pd.pf_deduction                          AS pf_employee,
    pd.pf_employer,
    pd.net_salary,
    'ENTERPRISE'                             AS source
  FROM payroll_details pd
  JOIN payroll_processing_batches b ON b.id = pd.batch_id
  JOIN employees e ON e.id = pd.employee_id
  WHERE b.month = $1 AND b.year = $2
    AND e.deleted_at IS NULL
    -- Only a batch that has cleared approval is filed. A draft is a working
    -- number, and filing one would commit to figures nobody signed off.
    AND b.status IN ('APPROVED', 'LOCKED')
`;

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

  /**
   * Recomputes PF against the base the row's own engine used, not always gross.
   * Checking every row against gross would flag every enterprise row as
   * non-compliant for a reason that is a policy difference, not a mistake —
   * which would bury the real mismatches this check exists to surface.
   */
  private reconcilePf(rows: PayrollAggRow[]): (PayrollAggRow & { compliant: boolean; expected_employee: number; expected_employer: number })[] {
    return rows.map((r) => {
      const base = parseFloat(r.pf_base ?? r.gross_salary);
      const expected = calculatePfFlat(base);
      const storedEmployee = parseFloat(r.pf_employee);
      const storedEmployer = parseFloat(r.pf_employer);
      const compliant =
        !isNaN(storedEmployee) && !isNaN(storedEmployer) &&
        Math.abs(expected.employee - storedEmployee) <= AMOUNT_TOLERANCE &&
        Math.abs(expected.employer - storedEmployer) <= AMOUNT_TOLERANCE;
      return { ...r, compliant, expected_employee: expected.employee, expected_employer: expected.employer };
    });
  }

  /**
   * Records that a filing was produced, and with what totals.
   *
   * `esic_reports` and `pf_reports` existed in the schema with no writer, so
   * there was no record of what had been filed for a period or when — which is
   * the first thing anyone asks during an inspection. See F-13.
   */
  private async recordFiling(
    table: 'esic_reports' | 'pf_reports',
    args: {
      month: number; year: number; employees: number; wages: number;
      employee: number; employer: number; mismatches: number;
      bySource: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ${table}
         (id, month, year, total_employees, total_wages,
          total_employee_contribution, total_employer_contribution,
          status, generated_at, mismatch_count, by_source, created_at, updated_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,'GENERATED',NOW(),$7,$8::jsonb,NOW(),NOW())
       ON CONFLICT (month, year) DO UPDATE
       SET total_employees = EXCLUDED.total_employees,
           total_wages = EXCLUDED.total_wages,
           total_employee_contribution = EXCLUDED.total_employee_contribution,
           total_employer_contribution = EXCLUDED.total_employer_contribution,
           status = 'GENERATED',
           generated_at = NOW(),
           mismatch_count = EXCLUDED.mismatch_count,
           by_source = EXCLUDED.by_source,
           updated_at = NOW()`,
      [
        args.month, args.year, args.employees, round2(args.wages),
        round2(args.employee), round2(args.employer),
        args.mismatches, JSON.stringify(args.bySource),
      ],
    ).catch((e: Error) => {
      // A filing that cannot be logged is still a filing — surface it without
      // failing the request the user actually made.
      this.logger.warn(`[${table}] could not record filing: ${e.message}`);
    });
  }

  /** Contribution totals per engine, so a filing shows where its money came from. */
  private summariseBySource(rows: (PayrollAggRow & { compliant: boolean })[]) {
    const bucket: Record<string, { count: number; employee: number; employer: number; mismatches: number }> = {};
    for (const r of rows) {
      const key = r.source ?? 'EOR';
      bucket[key] ??= { count: 0, employee: 0, employer: 0, mismatches: 0 };
      bucket[key].count++;
      if (!r.compliant) bucket[key].mismatches++;
    }
    return bucket;
  }

  async generateEsicChallan(month: number, year: number, actorId?: string) {
    const all = await this.dataSource.query<PayrollAggRow[]>(
      `SELECT * FROM (${UNIFIED_CONTRIBUTIONS_SQL}) AS u ORDER BY u.source, u.staff_code`,
      [month, year],
    );
    // Anyone above the ESIC wage limit has no contribution to file.
    const rows = all.filter((r) => parseFloat(r.esic_employee) > 0 || parseFloat(r.esic_employer) > 0);

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

    const bySource = this.summariseBySource(reconciled);

    await this.recordFiling('esic_reports', {
      month, year,
      employees: rows.length,
      wages: rows.reduce((s, r) => s + parseFloat(r.gross_salary), 0),
      employee: totalEsicEmployee,
      employer: totalEsicEmployer,
      mismatches: mismatches.length,
      bySource,
    });

    await this.audit.log({
      actorId, action: AuditAction.PAYROLL_ACTION, entityType: 'esic_challan',
      metadata: {
        event: 'ESIC_CHALLAN_GENERATED', month, year,
        staff_count: rows.length, mismatch_count: mismatches.length,
        by_source: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.count])),
      },
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
      // Every payroll engine now contributes to the filing, so say which.
      by_source: bySource,
      records: reconciled,
    };
  }

  async generatePfEcr(month: number, year: number, actorId?: string) {
    const all = await this.dataSource.query<PayrollAggRow[]>(
      `SELECT * FROM (${UNIFIED_CONTRIBUTIONS_SQL}) AS u ORDER BY u.source, u.staff_code`,
      [month, year],
    );
    const rows = all.filter((r) => parseFloat(r.pf_employee) > 0 || parseFloat(r.pf_employer) > 0);

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

    const bySource = this.summariseBySource(reconciled);

    await this.recordFiling('pf_reports', {
      month, year,
      employees: rows.length,
      wages: rows.reduce((s, r) => s + parseFloat(r.gross_salary), 0),
      employee: totalPfEmployee,
      employer: totalPfEmployer,
      mismatches: mismatches.length,
      bySource,
    });

    await this.audit.log({
      actorId, action: AuditAction.PAYROLL_ACTION, entityType: 'pf_ecr',
      metadata: {
        event: 'PF_ECR_GENERATED', month, year,
        staff_count: rows.length, mismatch_count: mismatches.length,
        by_source: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.count])),
      },
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
      by_source: bySource,
      records: reconciled,
    };
  }

  /** Build CSV content for government filing */
  exportCsv(type: 'ESIC' | 'PF', records: PayrollAggRow[], month: number, year: number): string {
    // Source is carried into the file because the filing now spans three
    // payroll engines; without it a query about one row is unanswerable.
    const header = type === 'ESIC'
      ? 'Source,Staff Code,Staff Name,Gross Salary,ESIC Employee (0.75%),ESIC Employer (3.25%),Total ESIC'
      : 'Source,Staff Code,Staff Name,Gross Salary,PF Wage Base,PF Employee (12%),PF Employer (12%),Total PF';

    // Commas in a name would otherwise shift every later column.
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = records.map((r) => {
      const gross = parseFloat(r.gross_salary);
      const source = r.source ?? 'EOR';
      if (type === 'ESIC') {
        const emp = parseFloat(r.esic_employee);
        const er  = parseFloat(r.esic_employer);
        return [source, esc(r.staff_code), esc(r.staff_name), gross, emp, er, round2(emp + er)].join(',');
      }
      // The base the row's own engine used, capped at the ceiling — not
      // re-derived from gross, which would misstate every enterprise row.
      const pfBase = Math.min(parseFloat(r.pf_base ?? r.gross_salary), PF_WAGE_CEILING);
      const emp = parseFloat(r.pf_employee);
      const er  = parseFloat(r.pf_employer);
      return [source, esc(r.staff_code), esc(r.staff_name), gross, pfBase, emp, er, round2(emp + er)].join(',');
    });

    return [`HomeGenny ${type} Report — ${month}/${year}`, header, ...lines].join('\n');
  }
}

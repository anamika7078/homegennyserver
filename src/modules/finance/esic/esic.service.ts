import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

// Statutory rates — single source of truth
const ESIC_EMPLOYEE_RATE = 0.0075;
const ESIC_EMPLOYER_RATE = 0.0325;
const ESIC_WAGE_LIMIT    = 21_000;
const PF_RATE            = 0.12;
const PF_WAGE_CEILING    = 15_000;

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
  constructor(private readonly dataSource: DataSource) {}

  async generateEsicChallan(month: number, year: number) {
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

    const totalEsicEmployee = rows.reduce((s, r) => s + parseFloat(r.esic_employee), 0);
    const totalEsicEmployer = rows.reduce((s, r) => s + parseFloat(r.esic_employer), 0);

    return {
      month, year,
      period_label: `${month}/${year}`,
      rates: { employee: `${ESIC_EMPLOYEE_RATE * 100}%`, employer: `${ESIC_EMPLOYER_RATE * 100}%` },
      wage_limit: ESIC_WAGE_LIMIT,
      total_employee_contribution: Math.round(totalEsicEmployee * 100) / 100,
      total_employer_contribution: Math.round(totalEsicEmployer * 100) / 100,
      total_challan_amount: Math.round((totalEsicEmployee + totalEsicEmployer) * 100) / 100,
      staff_count: rows.length,
      records: rows,
    };
  }

  async generatePfEcr(month: number, year: number) {
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

    const totalPfEmployee = rows.reduce((s, r) => s + parseFloat(r.pf_employee), 0);
    const totalPfEmployer = rows.reduce((s, r) => s + parseFloat(r.pf_employer), 0);

    return {
      month, year,
      period_label: `${month}/${year}`,
      rates:    { employee: `${PF_RATE * 100}%`, employer: `${PF_RATE * 100}%` },
      wage_ceiling: PF_WAGE_CEILING,
      total_employee_contribution: Math.round(totalPfEmployee * 100) / 100,
      total_employer_contribution: Math.round(totalPfEmployer * 100) / 100,
      total_ecr_amount: Math.round((totalPfEmployee + totalPfEmployer) * 100) / 100,
      staff_count: rows.length,
      records: rows,
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

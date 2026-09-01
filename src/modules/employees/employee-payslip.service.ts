import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import PDFDocument = require('pdfkit');

/**
 * Where a payslip row came from. HomeGenny grew three separate payroll paths
 * and each writes its own table; HR needs one list, so every row carries its
 * origin and a `ref` that addresses it unambiguously.
 */
export type PayslipSource = 'HR_PAYROLL' | 'ENTERPRISE' | 'FIELD_PAYROLL';

export interface UnifiedPayslip {
  ref: string;
  source: PayslipSource;
  sourceLabel: string;
  periodMonth: number;
  periodYear: number;
  presentDays: number | null;
  grossSalary: number;
  totalDeductions: number;
  netSalary: number;
  deductionBreakdown: Record<string, number>;
  status: string;
  payslipNumber: string | null;
  storedPdfUrl: string | null;
  generatedAt: string | null;
}

const SOURCE_LABELS: Record<PayslipSource, string> = {
  HR_PAYROLL: 'HR payroll',
  ENTERPRISE: 'Enterprise payroll',
  FIELD_PAYROLL: 'Field / placement payroll',
};

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function inr(value: number): string {
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * One payslip list per employee, across every payroll path in the system.
 *
 * There are three, and none of them knew about the others:
 *  - `employee_payrolls` — what HR's own "generate payroll" writes
 *  - `payroll_details` + `payslip_documents` — the enterprise batch run
 *  - `payroll_entries` + `payroll_payslips` — the placement/field run, keyed by
 *    `staff_applicants.id`, which only became reachable from an employee once
 *    `employees.staff_applicant_id` existed
 *
 * HR opening one employee should not have to know which of the three paid them
 * in a given month, so this merges all three and sorts by period.
 */
@Injectable()
export class EmployeePayslipService {
  constructor(private readonly prisma: PrismaService) {}

  async listForEmployee(employeeId: string): Promise<{ items: UnifiedPayslip[]; total: number }> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { id: true, staffApplicantId: true },
    });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);

    const [hrRows, enterpriseRows, fieldRows] = await Promise.all([
      this.prisma.employeePayroll.findMany({
        where: { employeeId },
        orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
      }),
      this.prisma.payrollDetail.findMany({
        where: { employeeId },
        include: { batch: true, payslip: true },
      }),
      // Only reachable for a pipeline-onboarded employee — the field payroll is
      // keyed by the applicant id, not the employee id.
      //
      // Reads `payroll_records`, which is what the EOR/field payroll actually
      // writes (PayrollService.runAttendancePayroll). This used to read
      // `payroll_entries`, a table nothing in the codebase has ever written —
      // so a deployed staff member's payslip could never appear here no matter
      // how correctly their payroll ran. See F-04 in FINANCE_MODULE_AUDIT.md.
      employee.staffApplicantId
        ? this.prisma.payrollRecord.findMany({
            where: { staffId: employee.staffApplicantId },
            orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
          })
        : Promise.resolve([]),
    ]);

    const items: UnifiedPayslip[] = [
      ...hrRows.map((r): UnifiedPayslip => {
        const deductions = (r.deductions ?? {}) as Record<string, unknown>;
        const breakdown = Object.fromEntries(
          Object.entries(deductions).map(([k, v]) => [k, num(v)]),
        );
        return {
          ref: `HR_PAYROLL:${r.id}`,
          source: 'HR_PAYROLL',
          sourceLabel: SOURCE_LABELS.HR_PAYROLL,
          periodMonth: r.periodMonth,
          periodYear: r.periodYear,
          presentDays: num(r.presentDays),
          grossSalary: num(r.grossSalary),
          totalDeductions: Object.values(breakdown).reduce((a, b) => a + b, 0),
          netSalary: num(r.netSalary),
          deductionBreakdown: breakdown,
          status: r.status,
          payslipNumber: null,
          storedPdfUrl: null,
          generatedAt: r.createdAt?.toISOString() ?? null,
        };
      }),
      ...enterpriseRows.map((r): UnifiedPayslip => ({
        ref: `ENTERPRISE:${r.id}`,
        source: 'ENTERPRISE',
        sourceLabel: SOURCE_LABELS.ENTERPRISE,
        periodMonth: r.batch.month,
        periodYear: r.batch.year,
        presentDays: num(r.presentDays),
        grossSalary: num(r.grossSalary),
        totalDeductions: num(r.totalDeduction),
        netSalary: num(r.netSalary),
        deductionBreakdown: {
          pf: num(r.pfDeduction),
          esic: num(r.esicDeduction),
          tds: num(r.tdsDeduction),
          professionalTax: num(r.ptDeduction),
          loanEmi: num(r.loanEmiDeduction),
          advance: num(r.advanceDeduction),
          lwp: num(r.lwpDeduction),
        },
        status: r.paymentStatus,
        payslipNumber: r.payslip?.payslipNumber ?? null,
        storedPdfUrl: r.payslip?.pdfUrl ?? null,
        generatedAt: (r.payslip?.generatedAt ?? r.createdAt)?.toISOString() ?? null,
      })),
      ...fieldRows.map((r): UnifiedPayslip => ({
        ref: `FIELD_PAYROLL:${r.id}`,
        source: 'FIELD_PAYROLL',
        sourceLabel: SOURCE_LABELS.FIELD_PAYROLL,
        periodMonth: r.periodMonth,
        periodYear: r.periodYear,
        presentDays: r.shiftDays,
        grossSalary: num(r.grossSalary),
        totalDeductions: num(r.esicEmployee) + num(r.pfEmployee),
        netSalary: num(r.netSalary),
        deductionBreakdown: { esic: num(r.esicEmployee), pf: num(r.pfEmployee) },
        // payroll_records carries no status column — disbursement is the only
        // state it records, so derive rather than invent one.
        status: r.disbursedAt ? 'PAID' : 'PENDING',
        payslipNumber: null,
        storedPdfUrl: null,
        generatedAt: r.createdAt?.toISOString() ?? null,
      })),
    ];

    items.sort(
      (a, b) =>
        b.periodYear - a.periodYear ||
        b.periodMonth - a.periodMonth ||
        a.source.localeCompare(b.source),
    );

    return { items, total: items.length };
  }

  /**
   * Renders a payslip PDF from live data rather than serving a stored file.
   *
   * Some rows do carry a `storedPdfUrl` from an older batch run, but not all
   * three paths produce one and the stored copies live in different buckets —
   * so generating from the same numbers the list shows keeps every payslip
   * identical in format and guarantees it exists.
   */
  async renderPdf(employeeId: string, ref: string): Promise<{ buffer: Buffer; filename: string }> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      include: { branch: true, category: true },
    });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);

    const { items } = await this.listForEmployee(employeeId);
    const slip = items.find((i) => i.ref === ref);
    if (!slip) {
      throw new NotFoundException(
        `No payslip ${ref} for this employee. Refresh the list — refs change if a payroll run is re-created.`,
      );
    }

    const buffer = await this.buildPdf(employee, slip);
    const period = `${String(slip.periodMonth).padStart(2, '0')}-${slip.periodYear}`;
    return { buffer, filename: `payslip-${employee.employeeId}-${period}.pdf` };
  }

  private buildPdf(employee: any, slip: UnifiedPayslip): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const monthName = new Date(slip.periodYear, slip.periodMonth - 1).toLocaleString('en-IN', {
        month: 'long',
      });

      doc.fontSize(18).text('HomeGenny', { align: 'center' });
      doc
        .fontSize(10)
        .fillColor('#555')
        .text(employee.branch?.name ?? 'HomeGenny', { align: 'center' });
      doc.moveDown(0.6);
      doc
        .fontSize(13)
        .fillColor('#000')
        .text(`Salary Slip — ${monthName} ${slip.periodYear}`, { align: 'center' });
      doc.moveDown(0.3);
      doc
        .fontSize(8)
        .fillColor('#777')
        .text(`${slip.sourceLabel}${slip.payslipNumber ? ` · ${slip.payslipNumber}` : ''}`, {
          align: 'center',
        });
      doc.fillColor('#000').moveDown(1);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const line = () => {
        doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.5);
      };

      line();
      const details: [string, string][] = [
        ['Employee', employee.fullName],
        ['Employee ID', employee.employeeId],
        ['Designation', employee.designation ?? '-'],
        ['Department', employee.department ?? '-'],
        ['Category', employee.category?.name ?? '-'],
        ['Date of joining', employee.joiningDate?.toISOString?.().slice(0, 10) ?? '-'],
        ['Days paid', slip.presentDays !== null ? String(slip.presentDays) : '-'],
      ];
      doc.fontSize(9);
      for (const [label, value] of details) {
        doc.fillColor('#666').text(label, left, doc.y, { continued: true, width: 200 });
        doc.fillColor('#000').text(String(value), { align: 'left' });
      }
      doc.moveDown(0.5);
      line();

      doc.moveDown(0.3).fontSize(11).fillColor('#000').text('Earnings');
      doc.fontSize(9);
      doc.fillColor('#666').text('Gross salary', left, doc.y, { continued: true, width: 320 });
      doc.fillColor('#000').text(`INR ${inr(slip.grossSalary)}`);
      doc.moveDown(0.5);

      doc.fontSize(11).text('Deductions');
      doc.fontSize(9);
      const deductions = Object.entries(slip.deductionBreakdown).filter(([, v]) => v > 0);
      if (deductions.length === 0) {
        doc.fillColor('#666').text('None', left, doc.y);
      } else {
        for (const [key, value] of deductions) {
          const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
          doc.fillColor('#666').text(label, left, doc.y, { continued: true, width: 320 });
          doc.fillColor('#000').text(`INR ${inr(value)}`);
        }
      }
      doc.moveDown(0.3);
      doc.fillColor('#666').text('Total deductions', left, doc.y, { continued: true, width: 320 });
      doc.fillColor('#000').text(`INR ${inr(slip.totalDeductions)}`);
      doc.moveDown(0.5);
      line();

      doc.fontSize(12).fillColor('#000').text('Net payable', left, doc.y, {
        continued: true,
        width: 320,
      });
      doc.fontSize(12).text(`INR ${inr(slip.netSalary)}`);
      doc.moveDown(0.4);
      doc.fontSize(9).fillColor('#666').text(`Payment status: ${slip.status}`, left, doc.y);
      doc.moveDown(1.5);

      doc
        .fontSize(7)
        .fillColor('#999')
        .text(
          'Computer-generated payslip — valid without signature. ' +
            `Generated ${new Date().toISOString().slice(0, 10)}.`,
          left,
          doc.y,
          { align: 'center', width: right - left },
        );

      doc.end();
    });
  }

  /** Validates and splits a `SOURCE:uuid` ref. Exposed for the controller's 400s. */
  static parseRef(ref: string): { source: PayslipSource; id: string } {
    const [source, id] = String(ref).split(':');
    if (!source || !id || !(source in SOURCE_LABELS)) {
      throw new BadRequestException(
        `Invalid payslip ref "${ref}". Expected one of ${Object.keys(SOURCE_LABELS).join('/')} followed by ":" and the row id.`,
      );
    }
    return { source: source as PayslipSource, id };
  }
}

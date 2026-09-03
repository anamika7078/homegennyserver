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
  /**
   * Where the month's earnings came from, when they came from more than one
   * client. A maid working three houses is paid once; her slip is one figure
   * with the houses listed under it. Absent for single-client months. See
   * docs/HOURLY_MULTI_CLIENT_PLAN.md §B5.
   */
  clientBreakdown?: {
    clientName: string;
    placementType: 'PERMANENT' | 'TEMPORARY';
    /** Hours for an hourly placement, days for a monthly one. */
    worked: string;
    grossSalary: number;
  }[];
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

  /**
   * One slip per month, not one per client.
   *
   * `payroll_records` is keyed by placement, which is right — each row is what
   * one client owes. But the staff member is paid once, so three houses in a
   * month used to show as three payslips for the same month, three net figures,
   * none of them what she actually received. They are folded into one, with the
   * houses listed underneath. See §B5.
   */
  private async foldFieldRowsByMonth(
    rows: {
      id: string; periodMonth: number; periodYear: number; shiftDays: number | null;
      grossSalary: unknown; netSalary: unknown; esicEmployee: unknown; pfEmployee: unknown;
      disbursedAt: Date | null; createdAt: Date | null; placementId: string | null;
      placementType?: string | null; hoursWorked?: unknown;
    }[],
  ): Promise<UnifiedPayslip[]> {
    if (!rows.length) return [];

    const placementIds = [...new Set(rows.map((r) => r.placementId).filter(Boolean))] as string[];
    const placements = placementIds.length
      ? await this.prisma.placement.findMany({
          where: { id: { in: placementIds } },
          select: { id: true, clientId: true },
        })
      : [];
    const clientIds = [...new Set(placements.map((p) => p.clientId))];
    const clients = clientIds.length
      ? await this.prisma.financeCustomer.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, customerName: true },
        })
      : [];
    const clientOf = new Map(placements.map((p) => [p.id, p.clientId]));
    const nameOf = new Map(clients.map((c) => [c.id, c.customerName]));

    const byMonth = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.periodYear}-${r.periodMonth}`;
      const bucket = byMonth.get(key);
      if (bucket) bucket.push(r);
      else byMonth.set(key, [r]);
    }

    return [...byMonth.values()].map((group): UnifiedPayslip => {
      const esic = group.reduce((s, r) => s + num(r.esicEmployee), 0);
      const pf = group.reduce((s, r) => s + num(r.pfEmployee), 0);
      const first = group[0];
      return {
        // Every row that makes up the month, so the slip can be traced back.
        ref: `FIELD_PAYROLL:${group.map((r) => r.id).join(',')}`,
        source: 'FIELD_PAYROLL',
        sourceLabel: SOURCE_LABELS.FIELD_PAYROLL,
        periodMonth: first.periodMonth,
        periodYear: first.periodYear,
        // Days at the house she attended most — summing days across houses
        // would claim more days than the month holds.
        presentDays: Math.max(...group.map((r) => r.shiftDays ?? 0)) || null,
        grossSalary: round2(group.reduce((s, r) => s + num(r.grossSalary), 0)),
        totalDeductions: round2(esic + pf),
        netSalary: round2(group.reduce((s, r) => s + num(r.netSalary), 0)),
        deductionBreakdown: { esic: round2(esic), pf: round2(pf) },
        // payroll_records carries no status column — disbursement is the only
        // state it records, so derive rather than invent one. Not paid until
        // every client's share is.
        status: group.every((r) => r.disbursedAt) ? 'PAID' : 'PENDING',
        payslipNumber: null,
        storedPdfUrl: null,
        generatedAt: first.createdAt?.toISOString() ?? null,
        ...(group.length > 1
          ? {
              clientBreakdown: group.map((r) => {
                const type = (r.placementType as 'PERMANENT' | 'TEMPORARY') ?? 'PERMANENT';
                return {
                  clientName:
                    nameOf.get(clientOf.get(r.placementId ?? '') ?? '') ?? 'Unknown client',
                  placementType: type,
                  worked: type === 'TEMPORARY'
                    ? `${num(r.hoursWorked)} hours`
                    : `${r.shiftDays ?? 0} days`,
                  grossSalary: round2(num(r.grossSalary)),
                };
              }),
            }
          : {}),
      };
    });
  }

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
      ...(await this.foldFieldRowsByMonth(fieldRows)),
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
   * Every payslip for a period, across everyone — HR's month-end view.
   *
   * Payroll is a Finance action, but the salary slip it produces is HR's
   * business, and until now HR could only reach one person's slips at a time.
   * Reads `payroll_records`, the single payroll engine, so this list and the
   * client's invoice are built from the same rows.
   *
   * One row per person, not per placement. A maid working three houses has
   * three payroll rows — that is right, each is what one client owes — but she
   * is paid once, so listing her three times with three net figures would show
   * HR three salaries where there is one. See §B5.
   */
  async listForPeriod(month: number, year: number) {
    const rows = await this.prisma.payrollRecord.findMany({
      where: { periodMonth: month, periodYear: year },
      orderBy: { createdAt: 'desc' },
    });
    if (!rows.length) return { items: [], total: 0, month, year };

    const staffIds = [...new Set(rows.map((r) => r.staffId))];
    const placementIds = [...new Set(rows.map((r) => r.placementId).filter(Boolean))] as string[];
    const [applicants, employees, placements] = await Promise.all([
      this.prisma.staffApplicant.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, staffCode: true, fullName: true },
      }),
      this.prisma.employee.findMany({
        where: { staffApplicantId: { in: staffIds } },
        select: { id: true, employeeId: true, staffApplicantId: true, department: true },
      }),
      placementIds.length
        ? this.prisma.placement.findMany({
            where: { id: { in: placementIds } },
            select: { id: true, clientId: true },
          })
        : Promise.resolve([] as { id: string; clientId: string }[]),
    ]);
    const clientIds = [...new Set(placements.map((p) => p.clientId))];
    const clients = clientIds.length
      ? await this.prisma.financeCustomer.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, customerName: true },
        })
      : [];

    const byStaff = new Map(applicants.map((a) => [a.id, a]));
    const empByStaff = new Map(employees.map((e) => [e.staffApplicantId!, e]));
    const clientOf = new Map(placements.map((p) => [p.id, p.clientId]));
    const nameOf = new Map(clients.map((c) => [c.id, c.customerName]));

    const byPerson = new Map<string, typeof rows>();
    for (const r of rows) {
      const bucket = byPerson.get(r.staffId);
      if (bucket) bucket.push(r);
      else byPerson.set(r.staffId, [r]);
    }

    const items = [...byPerson.entries()].map(([staffId, group]) => {
      const who = byStaff.get(staffId);
      const emp = empByStaff.get(staffId);
      const deductions = group.reduce(
        (s, r) => s + Number(r.esicEmployee ?? 0) + Number(r.pfEmployee ?? 0), 0,
      );
      return {
        ref: `FIELD_PAYROLL:${group.map((r) => r.id).join(',')}`,
        employeeId: emp?.id ?? null,
        employeeCode: emp?.employeeId ?? who?.staffCode ?? null,
        staffCode: who?.staffCode ?? null,
        staffName: who?.fullName ?? null,
        department: emp?.department ?? null,
        periodMonth: month,
        periodYear: year,
        // The most days at any one house. Summing across houses would claim
        // more days than the month holds.
        presentDays: Math.max(...group.map((r) => r.shiftDays ?? 0)),
        grossSalary: round2(group.reduce((s, r) => s + Number(r.grossSalary ?? 0), 0)),
        totalDeductions: round2(deductions),
        netSalary: round2(group.reduce((s, r) => s + Number(r.netSalary ?? 0), 0)),
        // Not paid, and not invoiced, until every client's share is.
        status: group.every((r) => r.disbursedAt) ? 'PAID' : 'PENDING',
        // Null when payroll ran but the client's invoice could not be touched
        // — an already-sent invoice, for instance.
        invoiced: group.every((r) => Boolean(r.client_invoice_id)),
        /** Which houses this month's pay came from, when it came from several. */
        clients: group.length > 1
          ? group.map((r) => ({
              clientName: nameOf.get(clientOf.get(r.placementId ?? '') ?? '') ?? 'Unknown client',
              placementType: (r.placementType as 'PERMANENT' | 'TEMPORARY') ?? 'PERMANENT',
              worked: r.placementType === 'TEMPORARY'
                ? `${Number(r.hoursWorked ?? 0)} hours`
                : `${r.shiftDays ?? 0} days`,
              grossSalary: round2(Number(r.grossSalary ?? 0)),
              invoiced: Boolean(r.client_invoice_id),
            }))
          : undefined,
      };
    });

    return { items, total: items.length, month, year };
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
      // A month worked across several houses is paid once, so the gross is a
      // sum. Show what it is a sum of, or the figure has to be taken on trust.
      if (slip.clientBreakdown?.length) {
        for (const b of slip.clientBreakdown) {
          doc
            .fillColor('#666')
            .text(`${b.clientName} · ${b.worked}`, left, doc.y, { continued: true, width: 320 });
          doc.fillColor('#000').text(`INR ${inr(b.grossSalary)}`);
        }
        doc.moveDown(0.2);
      }
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

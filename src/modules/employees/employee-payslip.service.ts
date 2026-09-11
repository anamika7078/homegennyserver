import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildWageRegister, EARNING_COMPONENTS, DEDUCTION_COMPONENTS, type WageConfigLike,
} from '../../common/finance/wage-register.util';
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

    const context = await this.registerContext(employee, slip);
    const buffer = await this.buildPdf(employee, slip, context);
    const period = `${String(slip.periodMonth).padStart(2, '0')}-${slip.periodYear}`;
    return { buffer, filename: `payslip-${employee.employeeId}-${period}.pdf` };
  }

  /**
   * The wage terms and posting details a register has to show alongside the
   * figures: which unit the person was posted at, what was agreed for the
   * placement, and the account the money goes to.
   *
   * Only a field payroll has a placement behind it. An HR or enterprise
   * payroll is an office employee with no client posting, so the unit is
   * HomeGenny itself and the wage has no client-side breakup to read.
   */
  private async registerContext(employee: any, slip: UnifiedPayslip) {
    const placement = employee.staffApplicantId
      ? await this.prisma.placement.findFirst({
          where: { staffId: employee.staffApplicantId, status: { in: ['CONFIRMED', 'TRIAL'] } },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    const client = placement
      ? await this.prisma.financeCustomer.findUnique({
          where: { id: placement.clientId },
          select: { customerName: true, unitCode: true, address: true },
        })
      : null;

    const bank = employee.staffApplicantId
      ? await this.prisma.$queryRaw<{ account_number: string; ifsc: string }[]>`
          SELECT account_number, ifsc FROM staff_bank_accounts
           WHERE staff_id = ${employee.staffApplicantId}::uuid
           ORDER BY created_at DESC LIMIT 1`
      : [];

    const meta = (placement?.metadata ?? {}) as { wage_config?: WageConfigLike };
    const daysInMonth = new Date(slip.periodYear, slip.periodMonth, 0).getDate();

    const register = buildWageRegister({
      config: meta.wage_config ?? null,
      monthlyWage: Number(placement?.staffSalary ?? 0),
      daysWorked: slip.presentDays ?? 0,
      daysInMonth,
      esicEmployee: Number(slip.deductionBreakdown?.esic ?? 0),
      pfEmployee: Number(slip.deductionBreakdown?.pf ?? 0),
    });

    // The account number is stored whole but shown to its last four here, the
    // same as everywhere else it is displayed. A register needs to identify
    // the account, not reproduce it.
    const acct = bank[0]?.account_number ?? null;
    return {
      register,
      unitCode: client?.unitCode ?? null,
      unitName: client?.customerName ?? null,
      unitAddress: client?.address ?? null,
      accountMasked: acct ? `XXXXXX${acct.slice(-4)}` : null,
      ifsc: bank[0]?.ifsc ?? null,
    };
  }

  /**
   * The slip as a wage register.
   *
   * Laid out the way the statutory registers are, because it stands in for all
   * of them at once: the paying scale on one row, what the days worked
   * actually earned on the row beneath it, deductions under that, and the net
   * with a place to sign. The previous layout listed a gross and two
   * deductions, which is a summary — nothing on it could be checked against
   * an entitlement, and it named no unit, no account and no period boundaries.
   */
  private buildPdf(
    employee: any,
    slip: UnifiedPayslip,
    ctx: Awaited<ReturnType<EmployeePayslipService['registerContext']>>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Landscape: the register is a wide table and portrait forces the
      // component columns into an unreadable width.
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const { register: reg } = ctx;
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const width = right - left;
      const monthName = new Date(slip.periodYear, slip.periodMonth - 1)
        .toLocaleString('en-IN', { month: 'long' });

      const rule = (thickness = 1, colour = '#000') => {
        doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(thickness).strokeColor(colour).stroke();
        doc.moveDown(0.4);
      };
      /** One row of the component grid, laid out on a shared column geometry. */
      const gridRow = (label: string, values: string[], opts: { bold?: boolean } = {}) => {
        const labelWidth = 110;
        const cell = (width - labelWidth) / values.length;
        const y = doc.y;
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor('#000');
        doc.text(label, left, y, { width: labelWidth });
        values.forEach((v, i) => {
          doc.text(v, left + labelWidth + i * cell, y, { width: cell - 4, align: 'right' });
        });
        doc.y = y + 12;
      };

      // ── the statutory heading ────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000').text(
        `${(employee.branch?.name ?? 'HomeGenny').toUpperCase()} : IN LIEU OF MUSTER ROLL FORM XVI, ` +
          'REGISTER OF WAGES FORM XVII, WAGES SLIP FORM XIX',
        left, doc.y, { width },
      );
      doc.font('Helvetica').fontSize(7.5).text(
        'LEAVE WITH WAGES FORM F SEE RULE 8 S & C ACT',
        left, doc.y, { width: width * 0.45, continued: false },
      );
      const headY = doc.y - 9;
      doc.font('Helvetica-Bold').text(`For the Month of  ${monthName}-${slip.periodYear}`,
        left + width * 0.45, headY, { width: width * 0.35 });
      doc.font('Helvetica').fontSize(7).fillColor('#444').text(
        slip.payslipNumber ?? slip.sourceLabel, left + width * 0.8, headY, { width: width * 0.2, align: 'right' });
      doc.fillColor('#000').moveDown(0.4);
      rule(1.2);

      // ── who, where, and on what terms ────────────────────────────────────
      // `labelW` is explicit because the labels are not the same length —
      // "DAYS WORKED :" wrapped onto a second line at a fixed 52pt and pushed
      // the row below it out of alignment.
      const pair = (label: string, value: string, x: number, y: number, w: number, labelW = 52) => {
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#000')
          .text(label, x, y, { width: labelW, lineBreak: false });
        doc.font('Helvetica').fontSize(7.5)
          .text(value || '—', x + labelW + 2, y, { width: w - labelW - 2, lineBreak: false });
      };
      const col = width / 4;
      let y = doc.y;
      pair('CODE NO :', employee.employeeId ?? '—', left, y, col);
      pair('NAME :', employee.fullName ?? '—', left + col, y, col);
      pair('ESI No.', '—', left + col * 2, y, col);
      pair('PF No.', '—', left + col * 3, y, col);
      y += 12;
      pair('DESGN. :', employee.designation ?? '—', left, y, col);
      pair('UNIT :', ctx.unitCode ? `${ctx.unitCode} — ${ctx.unitName}` : (ctx.unitName ?? 'HomeGenny'),
        left + col, y, col * 2);
      pair('UAN No.', '—', left + col * 3, y, col);
      y += 12;
      pair('DAYS WORKED :', `${reg.daysWorked.toFixed(2)} of ${reg.daysInMonth}`, left, y, col, 66);
      pair('NFH :', reg.earned.nfh.toFixed(2), left + col, y, col * 0.5);
      pair('DOJ :', employee.joiningDate?.toISOString?.().slice(0, 10) ?? '—', left + col * 1.5, y, col * 0.8);
      pair('A/C No.', ctx.accountMasked ?? '—', left + col * 3, y, col);
      doc.y = y + 14;
      rule(0.5, '#666');

      // ── the wage grid ────────────────────────────────────────────────────
      const earnLabels: string[] = [...EARNING_COMPONENTS.map((c) => c.label), 'TOTAL'];
      gridRow('', earnLabels, { bold: true });
      doc.moveDown(0.1);
      gridRow('PAYING SCALE',
        [...EARNING_COMPONENTS.map((c) => inr(reg.scale[c.key])), inr(reg.scaleTotal)]);
      gridRow('WAGE EARNED',
        [...EARNING_COMPONENTS.map((c) => inr(reg.earned[c.key])), inr(reg.earnedTotal)], { bold: true });
      doc.moveDown(0.5);

      const dedLabels: string[] = [...DEDUCTION_COMPONENTS.map((c) => c.label), 'TOTAL DEDN'];
      gridRow('', dedLabels, { bold: true });
      doc.moveDown(0.1);
      gridRow('DEDUCTIONS',
        [...DEDUCTION_COMPONENTS.map((c) => inr(reg.deductions[c.key])), inr(reg.deductionTotal)]);
      doc.moveDown(0.6);
      rule(0.5, '#666');

      // ── net, and somewhere to sign ───────────────────────────────────────
      y = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
        .text('NET SALARY PAYABLE', left, y, { width: width * 0.6 });
      doc.fontSize(11).text(inr(reg.netPayable), left + width * 0.6, y - 2,
        { width: width * 0.4, align: 'right' });
      doc.y = y + 18;
      rule(1.2);

      doc.font('Helvetica').fontSize(7).fillColor('#666')
        .text(`Payment status: ${slip.status}`, left, doc.y, { width: width * 0.5, continued: false });
      doc.fontSize(7).text('SIGNATURE', left + width * 0.75, doc.y - 9,
        { width: width * 0.25, align: 'right' });
      doc.moveDown(1);

      // A month worked across several houses is paid once. The register shows
      // one net figure, so say what it is a sum of or it cannot be checked.
      if (slip.clientBreakdown?.length && slip.clientBreakdown.length > 1) {
        doc.fontSize(7).fillColor('#000').font('Helvetica-Bold')
          .text('Earned across', left, doc.y, { width });
        doc.font('Helvetica').fillColor('#444');
        for (const b of slip.clientBreakdown) {
          doc.text(`${b.clientName} · ${b.worked} · INR ${inr(b.grossSalary)}`, left, doc.y, { width });
        }
        doc.moveDown(0.4);
      }

      // Say what the register is still missing rather than printing a dash and
      // letting it pass an inspection it would not survive.
      const gaps: string[] = ['ESI number', 'PF number', 'UAN'];
      if (reg.undifferentiated) {
        gaps.push('an agreed wage breakup (the whole wage is shown as basic)');
      }
      doc.fontSize(6.5).fillColor('#92400e').text(
        `Not yet on file: ${gaps.join(', ')}. Add these before this register is filed.`,
        left, doc.y, { width },
      );

      doc.moveDown(0.3).fontSize(6.5).fillColor('#999').text(
        `Computer-generated wage register — valid without signature. Generated ${new Date().toISOString().slice(0, 10)}.`,
        left, doc.y, { width, align: 'center' },
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

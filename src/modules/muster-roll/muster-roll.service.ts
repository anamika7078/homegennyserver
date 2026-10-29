import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FileStorageService } from '../../common/storage/file-storage.service';
import { readSupplierSettings } from '../../common/finance/supplier-settings';
import { designationFor } from '../../common/finance/service-lines.util';

type Actor = { id: string; role: string };

export interface MusterRow {
  sl: number;
  placement_id: string;
  staff_id: string;
  code: string;
  rank: string;
  name: string;
  father_or_husband_name: string | null;
  sex: string | null;
  /** Index 0 = day 1. P present, A absent, ½ half day, L leave, WO weekly off, '' nothing recorded. */
  days: string[];
  days_present: number;
  additional_hours: number;
  weekly_off: number;
  total: number;
  remarks: string;
}

export interface MusterModel {
  client_id: string;
  month: number;
  year: number;
  month_label: string;
  days_in_month: number;
  contractor: { name: string; address: string | null };
  principal_employer: { name: string; address: string | null };
  unit_code: string | null;
  nature_and_location: string;
  rows: MusterRow[];
  daily_mandays: number[];
  totals: { total_present: number; additional_hours: number; weekly_off: number; total_mandays: number };
  /** How the staff-app days stand — for the people who check the roll, not printed on it. */
  proof: Record<string, number>;
  disputed_days: number;
  generated_at: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MARK: Record<string, string> = { PRESENT: 'P', OVERTIME: 'P', HALF_DAY: '½', LEAVE: 'L', ABSENT: 'A' };
const SEX: Record<string, string> = { FEMALE: 'F', MALE: 'M', OTHER: 'O', F: 'F', M: 'M' };
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The Form XVI muster roll — the client's own record of who worked which day,
 * signed by them as principal employer.
 *
 * Built live from attendance for a client and month; once signed (in the
 * client app, or on paper and uploaded by the RM) it is stored exactly as
 * signed. Signing it confirms every staff-app day still waiting on the
 * client. Attendance changed after signing shows as a difference; signing
 * again makes a new version and keeps the old one.
 */
@Injectable()
export class MusterRollService {
  private readonly logger = new Logger(MusterRollService.name);

  constructor(private readonly prisma: PrismaService, private readonly storage: FileStorageService) {}

  private sql<T>(q: string, ...params: unknown[]) {
    return this.prisma.$queryRawUnsafe<T>(q, ...params);
  }

  private static period(month: unknown, year: unknown) {
    const m = Number(month), y = Number(year);
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new BadRequestException('month must be 1–12.');
    if (!Number.isInteger(y) || y < 2020 || y > 2100) throw new BadRequestException('year is not valid.');
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${y}-${String(m).padStart(2, '0')}-${String(days).padStart(2, '0')}`;
    return { m, y, from, to, days };
  }

  /** The roll for a client and month, from attendance as it stands now. */
  async build(clientId: string, month: unknown, year: unknown): Promise<MusterModel> {
    const { m, y, from, to, days } = MusterRollService.period(month, year);
    const [cust] = await this.sql<{ id: string; customer_name: string; address: string | null; city: string | null; state: string | null; pincode: string | null; unit_code: string | null }[]>(
      `SELECT id, customer_name, address, city, state, pincode, unit_code FROM finance_customers WHERE id = $1::uuid`, clientId,
    );
    if (!cust) throw new NotFoundException('Client not found.');
    const supplier = await readSupplierSettings({ query: (q: string, p?: unknown[]) => this.sql(q, ...(p ?? [])) } as never);

    const placements = await this.sql<{
      id: string; staff_id: string; staff_code: string; full_name: string; series: string | null; metadata: Record<string, unknown> | null;
      weekly_off_day: number | null; start: string | null; exit_date: string | null; emp_gender: string | null; designation: string | null;
    }[]>(
      `SELECT p.id, p.staff_id, sa.staff_code, sa.full_name, sa.series::text AS series, sa.metadata, p.weekly_off_day,
              COALESCE(p.trial_start_date, p.confirmed_at::date, p.created_at::date)::text AS start, p.exit_date::text AS exit_date,
              e.gender AS emp_gender, e.designation
         FROM placements p
         JOIN staff_applicants sa ON sa.id = p.staff_id
         LEFT JOIN employees e ON e.staff_applicant_id = sa.id AND e.deleted_at IS NULL
        WHERE p.client_id = $1::uuid
          AND (EXISTS (SELECT 1 FROM staff_daily_attendance d WHERE d.placement_id = p.id AND d.attendance_date BETWEEN $2::date AND $3::date)
               OR (p.status IN ('TRIAL','CONFIRMED')
                   AND COALESCE(p.trial_start_date, p.confirmed_at::date, p.created_at::date) <= $3::date
                   AND (p.exit_date IS NULL OR p.exit_date >= $2::date)))
        ORDER BY sa.staff_code, p.created_at`,
      clientId, from, to,
    );
    const att = placements.length
      ? await this.sql<{ placement_id: string; day: number; status: string; overtime_hours: string | null; source: string; client_status: string }[]>(
          `SELECT placement_id, EXTRACT(DAY FROM attendance_date)::int AS day, status::text AS status,
                  overtime_hours, source, client_status
             FROM staff_daily_attendance
            WHERE placement_id = ANY($1::uuid[]) AND attendance_date BETWEEN $2::date AND $3::date`,
          placements.map((p) => p.id), from, to,
        )
      : [];

    const proof: Record<string, number> = {};
    let disputed = 0;
    const daily = Array<number>(days).fill(0);
    const rows: MusterRow[] = placements.map((p, i) => {
      const meta = p.metadata ?? {};
      const marks = Array<string>(days).fill('');
      let present = 0, addl = 0, wo = 0, rowDisputed = 0;
      for (const a of att.filter((x) => x.placement_id === p.id)) {
        if (a.source === 'STAFF_APP') proof[a.client_status] = (proof[a.client_status] ?? 0) + 1;
        // A disputed day waits for the RM: it is left blank on the roll.
        if (a.client_status === 'DISPUTED') { rowDisputed += 1; continue; }
        const mark = MARK[a.status] ?? '';
        marks[a.day - 1] = mark;
        const worth = mark === 'P' ? 1 : mark === '½' ? 0.5 : 0;
        present += worth;
        daily[a.day - 1] += worth;
        addl += Number(a.overtime_hours ?? 0);
      }
      // The weekly off, on days nothing else was recorded, while placed.
      if (p.weekly_off_day != null) {
        for (let d = 1; d <= days; d++) {
          const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          if (marks[d - 1] || (p.start && iso < p.start) || (p.exit_date && iso > p.exit_date)) continue;
          if (new Date(`${iso}T00:00:00Z`).getUTCDay() === p.weekly_off_day) { marks[d - 1] = 'WO'; wo += 1; }
        }
      }
      disputed += rowDisputed;
      const remarks = [rowDisputed ? `${rowDisputed} day(s) under review` : '', p.exit_date && p.exit_date <= to ? `Left ${p.exit_date}` : ''].filter(Boolean).join('; ');
      return {
        sl: i + 1,
        placement_id: p.id,
        staff_id: p.staff_id,
        code: p.staff_code,
        rank: p.designation || designationFor(p.series),
        name: p.full_name,
        father_or_husband_name: (meta.father_or_husband_name as string | undefined) ?? null,
        sex: SEX[String(meta.gender ?? p.emp_gender ?? '').toUpperCase()] ?? null,
        days: marks,
        days_present: r1(present),
        additional_hours: r1(addl),
        weekly_off: wo,
        total: r1(present + wo),
        remarks,
      };
    });
    const where = [cust.address, cust.city, cust.state, cust.pincode].filter(Boolean).join(', ');
    const ranks = [...new Set(rows.map((r) => r.rank))].join(', ');
    return {
      client_id: cust.id,
      month: m,
      year: y,
      month_label: `${MONTHS[m - 1]} ${y}`,
      days_in_month: days,
      contractor: { name: supplier.legalName, address: supplier.address },
      principal_employer: { name: cust.customer_name, address: where || null },
      unit_code: cust.unit_code,
      nature_and_location: `${ranks || 'Domestic staff'} — ${where || cust.customer_name}`,
      rows,
      daily_mandays: daily.map(r1),
      totals: {
        total_present: r1(rows.reduce((s, r) => s + r.days_present, 0)),
        additional_hours: r1(rows.reduce((s, r) => s + r.additional_hours, 0)),
        weekly_off: rows.reduce((s, r) => s + r.weekly_off, 0),
        total_mandays: r1(rows.reduce((s, r) => s + r.total, 0)),
      },
      proof,
      disputed_days: disputed,
      generated_at: new Date().toISOString(),
    };
  }

  private async rolls(clientId: string, m: number, y: number) {
    return this.prisma.musterRoll.findMany({
      where: { clientId, periodMonth: m, periodYear: y },
      orderBy: { version: 'desc' },
    });
  }

  /** Did the attendance change after the current signed version? */
  private static changedSince(signed: MusterModel, live: MusterModel): string[] {
    const out: string[] = [];
    const byId = new Map(signed.rows.map((r) => [r.placement_id, r]));
    for (const r of live.rows) {
      const s = byId.get(r.placement_id);
      if (!s) { out.push(`${r.name} added`); continue; }
      r.days.forEach((mk, i) => { if ((s.days[i] ?? '') !== mk) out.push(`${r.name} day ${i + 1}: ${s.days[i] || '—'} → ${mk || '—'}`); });
    }
    for (const s of signed.rows) if (!live.rows.some((r) => r.placement_id === s.placement_id)) out.push(`${s.name} removed`);
    return out;
  }

  /** Live roll + its signed versions + whether attendance changed since the current one. */
  async view(clientId: string, month: unknown, year: unknown) {
    const live = await this.build(clientId, month, year);
    const all = await this.rolls(clientId, live.month, live.year);
    const current = all.find((r) => r.status !== 'SUPERSEDED') ?? null;
    return {
      ...live,
      signed: current
        ? {
            id: current.id, version: current.version, status: current.status, sign_method: current.signMethod,
            signed_at: current.signedAt, signed_name: current.signedName, has_scan: !!current.scanKey,
            note: current.note, locked: !!current.lockedAt,
          }
        : null,
      changed_since_signed: current ? MusterRollService.changedSince(current.snapshot as unknown as MusterModel, live) : [],
      versions: all.map((r) => ({ id: r.id, version: r.version, status: r.status, sign_method: r.signMethod, signed_at: r.signedAt, signed_name: r.signedName })),
    };
  }

  /** Printable Form XVI. `version` prints that signed version; otherwise the live roll. */
  async html(clientId: string, month: unknown, year: unknown, opts: { version?: number; audit?: boolean } = {}) {
    const live = await this.build(clientId, month, year);
    const all = await this.rolls(clientId, live.month, live.year);
    const roll = opts.version ? all.find((r) => r.version === opts.version) : all.find((r) => r.status !== 'SUPERSEDED');
    if (opts.version && !roll) throw new NotFoundException(`No signed version ${opts.version}.`);
    const model = opts.version && roll ? (roll.snapshot as unknown as MusterModel) : live;
    const signedBlock = roll && (opts.version || MusterRollService.changedSince(roll.snapshot as unknown as MusterModel, live).length === 0)
      ? roll.signMethod === 'CLIENT_APP'
        ? `Approved by <b>${esc(roll.signedName)}</b> on ${esc(new Date(roll.signedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} in the HomeGenny client app (version ${roll.version}).`
        : `Signed copy on file — uploaded ${esc(new Date(roll.signedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}${roll.signedName ? ` (${esc(roll.signedName)})` : ''} (version ${roll.version}).`
      : '';
    const dayHeads = Array.from({ length: model.days_in_month }, (_, i) => `<th class="d">${i + 1}</th>`).join('');
    const rowsHtml = model.rows.map((r) => `<tr>
      <td>${r.sl}</td><td>${esc(r.code)}</td><td>${esc(r.rank)}</td><td class="l">${esc(r.name)}</td>
      <td class="l">${esc(r.father_or_husband_name ?? '')}</td><td>${esc(r.sex ?? '')}</td>
      ${r.days.map((d) => `<td class="d${d === 'A' ? ' a' : d === 'WO' ? ' w' : ''}">${esc(d)}</td>`).join('')}
      <td>${r.days_present}</td><td>${r.additional_hours || ''}</td><td>${r.weekly_off || ''}</td><td>${r.total}</td><td class="l">${esc(r.remarks)}</td></tr>`).join('');
    const audit = opts.audit ? `
      <section class="audit"><h2>Attendance proof (internal — not part of Form XVI)</h2>
      <p>Staff-app days by client status: ${Object.entries(model.proof).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || 'none'}.
      ${model.disputed_days ? `${model.disputed_days} disputed day(s) are left blank until the RM resolves them.` : ''}
      HR- and RM-entered days need no client approval; their proof is this roll, signed.</p></section>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>Muster roll — ${esc(model.principal_employer.name)} — ${esc(model.month_label)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #000; margin: 0; padding: 12px; }
  .top { display: flex; justify-content: space-between; gap: 16px; }
  .form { text-align: center; } .form b { font-size: 13px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #333; padding: 2px 3px; text-align: center; }
  th { background: #eee; font-size: 9px; } td.l { text-align: left; } th.d, td.d { width: 16px; padding: 2px 0; }
  td.a { color: #b91c1c; } td.w { color: #555; font-size: 8px; }
  .sig { margin-top: 18px; display: flex; justify-content: space-between; align-items: flex-end; }
  .sig .box { width: 45%; border-top: 1px solid #000; padding-top: 4px; }
  .approved { margin-top: 10px; padding: 6px; border: 1px dashed #15803d; color: #15803d; }
  .audit { page-break-before: always; } .muted { color: #555; }
</style></head><body>
<div class="top">
  <div><b>UNIT CODE:</b> ${esc(model.unit_code ?? '')}<br>
    <b>Name and address of Contractor:</b> ${esc(model.contractor.name)}${model.contractor.address ? `, ${esc(model.contractor.address)}` : ''}<br>
    <b>Nature and location of work:</b> ${esc(model.nature_and_location)}</div>
  <div class="form"><b>FORM XVI</b><br>[See Rule 78(1)(a)(i)]<br><b>Muster Roll</b></div>
  <div><b>Name and address of establishment in / under which contract is carried on:</b> ${esc(model.principal_employer.name)}${model.principal_employer.address ? `, ${esc(model.principal_employer.address)}` : ''}<br>
    <b>Name and address of Principal Employer:</b> ${esc(model.principal_employer.name)}${model.principal_employer.address ? `, ${esc(model.principal_employer.address)}` : ''}<br>
    <b>For the month of:</b> ${esc(model.month_label)}</div>
</div>
<table>
  <thead><tr><th>Sl. No.</th><th>Code</th><th>Rank</th><th>Name of Workmen</th><th>Father's/Husband's Name</th><th>Sex</th>
    ${dayHeads}<th>No. of Days Present</th><th>Addi-tional HRS</th><th>W/O</th><th>TOTAL</th><th>Remarks</th></tr></thead>
  <tbody>${rowsHtml || `<tr><td colspan="${model.days_in_month + 11}">No staff placed this month.</td></tr>`}
    <tr><td colspan="6"><b>DAILY MANDAYS</b></td>${model.daily_mandays.map((n) => `<td class="d">${n || ''}</td>`).join('')}
      <td colspan="5" class="l">TOTAL PRESENT ${model.totals.total_present} · ADDITIONAL HOURS ${model.totals.additional_hours} · WEEKLY OFF ${model.totals.weekly_off} · TOTAL MANDAYS ${model.totals.total_mandays}</td></tr>
  </tbody>
</table>
<p class="muted">P present · ½ half day · A absent · L leave · WO weekly off · blank: not recorded${model.disputed_days ? ' or under review' : ''}.</p>
${signedBlock ? `<div class="approved">${signedBlock}</div>` : ''}
<div class="sig"><div class="box">Seal and Signature with Name and Designation of representative Principal Employer</div>
  <div class="box">For ${esc(model.contractor.name)}</div></div>
${audit}
</body></html>`;
  }

  private async customerOfClient(user: Actor) {
    const c = await this.prisma.financeCustomer.findFirst({ where: { userId: user.id }, select: { id: true } });
    if (!c) throw new ForbiddenException('No client account is linked to this login.');
    return c.id;
  }

  private async saveSigned(
    clientId: string, model: MusterModel,
    data: { status: 'SIGNED_DIGITAL' | 'SIGNED_PAPER'; method: 'CLIENT_APP' | 'PAPER_UPLOAD'; by: string; name: string | null; scanKey?: string; scanMime?: string; note?: string | null },
  ) {
    const all = await this.rolls(clientId, model.month, model.year);
    if (all.some((r) => r.lockedAt && r.status !== 'SUPERSEDED')) {
      throw new BadRequestException('This month\'s muster roll is locked with an approved invoice — corrections go through Finance.');
    }
    const version = (all[0]?.version ?? 0) + 1;
    const [roll] = await this.prisma.$transaction([
      this.prisma.musterRoll.create({
        data: {
          clientId, periodMonth: model.month, periodYear: model.year, version, status: data.status,
          snapshot: model as unknown as Prisma.InputJsonValue, signMethod: data.method, signedBy: data.by,
          signedName: data.name, scanKey: data.scanKey ?? null, scanMime: data.scanMime ?? null, note: data.note ?? null,
        },
      }),
      this.prisma.musterRoll.updateMany({
        where: { clientId, periodMonth: model.month, periodYear: model.year, status: { not: 'SUPERSEDED' }, version: { lt: version } },
        data: { status: 'SUPERSEDED' },
      }),
    ]);
    // Signing the roll confirms the staff-app days still waiting on the client.
    const confirmed = await this.sql<{ id: string }[]>(
      `UPDATE staff_daily_attendance sda
          SET client_status = $4, client_action_at = NOW(), client_action_by = $5::uuid,
              client_note = COALESCE(client_note, $6), updated_at = NOW()
         FROM placements p
        WHERE p.id = sda.placement_id AND p.client_id = $1::uuid
          AND sda.source = 'STAFF_APP' AND sda.client_status IN ('PENDING','DEEMED')
          AND sda.attendance_date BETWEEN $2::date AND $3::date
        RETURNING sda.id`,
      clientId,
      `${model.year}-${String(model.month).padStart(2, '0')}-01`,
      `${model.year}-${String(model.month).padStart(2, '0')}-${String(model.days_in_month).padStart(2, '0')}`,
      data.status === 'SIGNED_PAPER' ? 'APPROVED_PAPER' : 'APPROVED',
      data.by,
      `Muster roll ${model.month_label} v${version} ${data.method === 'CLIENT_APP' ? 'signed in the app' : 'signed on paper'}`,
    );
    this.logger.log(`[MUSTER_ROLL] ${clientId} ${model.month_label} v${version} ${data.status}: ${confirmed.length} day(s) confirmed`);
    return { id: roll.id, version, status: roll.status, days_confirmed: confirmed.length };
  }

  /** The client signs the month's roll in the app (their name, as they sign). */
  async signByClient(user: Actor, body: { month?: unknown; year?: unknown; name?: string }) {
    const clientId = await this.customerOfClient(user);
    const name = String(body.name ?? '').trim();
    if (name.length < 2) throw new BadRequestException('Type your name as you sign the muster roll.');
    const model = await this.build(clientId, body.month, body.year);
    if (!model.rows.length) throw new BadRequestException('No staff worked at your home in that month.');
    return this.saveSigned(clientId, model, { status: 'SIGNED_DIGITAL', method: 'CLIENT_APP', by: user.id, name });
  }

  /** The RM uploads the paper roll the client signed and stamped. */
  async uploadPaper(user: Actor, body: { client_id?: string; month?: unknown; year?: unknown; signed_name?: string; note?: string }, file?: { buffer: Buffer; mimetype: string; originalname?: string; size: number }) {
    if (!body.client_id) throw new BadRequestException('client_id is required.');
    if (!file?.buffer?.length) throw new BadRequestException('Attach the signed muster roll (photo or PDF).');
    const okTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!okTypes.includes(file.mimetype)) throw new BadRequestException('The signed roll must be a JPG, PNG, WEBP or PDF.');
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('The file is over 10 MB.');
    const model = await this.build(body.client_id, body.month, body.year);
    const ext = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype.split('/')[1];
    const key = `muster-rolls/${body.client_id}/${model.year}-${String(model.month).padStart(2, '0')}/${Date.now()}.${ext}`;
    await this.storage.save(key, file.buffer, file.mimetype);
    return this.saveSigned(body.client_id, model, {
      status: 'SIGNED_PAPER', method: 'PAPER_UPLOAD', by: user.id,
      name: body.signed_name ? String(body.signed_name).trim() || null : null,
      scanKey: key, scanMime: file.mimetype, note: body.note ? String(body.note).trim() || null : null,
    });
  }

  async scan(rollId: string, user: Actor) {
    const roll = await this.prisma.musterRoll.findUnique({ where: { id: rollId } });
    if (!roll?.scanKey) throw new NotFoundException('No signed scan for this muster roll.');
    if (user.role === 'CLIENT' && roll.clientId !== (await this.customerOfClient(user))) throw new ForbiddenException();
    return { stream: await this.storage.read(roll.scanKey), mime: roll.scanMime ?? 'application/octet-stream', name: `muster-roll-v${roll.version}.${(roll.scanMime ?? '').includes('pdf') ? 'pdf' : 'jpg'}` };
  }

  /** Clients who have had staff placed, for the picker. Name and unit code only. */
  async clients(search?: string) {
    const q = String(search ?? '').trim();
    return this.sql<{ id: string; customer_name: string; unit_code: string | null; attendance_proof_mode: string }[]>(
      `SELECT fc.id, fc.customer_name, fc.unit_code, fc.attendance_proof_mode
         FROM finance_customers fc
        WHERE EXISTS (SELECT 1 FROM placements p WHERE p.client_id = fc.id)
          AND ($1 = '' OR fc.customer_name ILIKE '%' || $1 || '%' OR fc.unit_code ILIKE '%' || $1 || '%')
        ORDER BY fc.customer_name
        LIMIT 50`,
      q,
    );
  }

  async viewForClient(user: Actor, month: unknown, year: unknown) {
    return this.view(await this.customerOfClient(user), month, year);
  }

  async htmlForClient(user: Actor, month: unknown, year: unknown) {
    return this.html(await this.customerOfClient(user), month, year);
  }
}

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, StaffAttendanceStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A staff-app day the client has not answered becomes DEEMED after this long. */
export const DEEMED_AFTER_HOURS = 48;

type Actor = { id: string; role: string };

interface DayRow {
  id: string;
  date: string;
  staff_id: string;
  staff_name: string;
  staff_code: string;
  placement_id: string;
  client_id: string;
  customer_name: string;
  status: string;
  hours_worked: string | null;
  source: string;
  client_status: string;
  client_note: string | null;
  client_action_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
  check_in: Date | null;
  check_out: Date | null;
}

const DAY_SELECT = `
  SELECT sda.id, sda.attendance_date::text AS date, sda.staff_id, sa.full_name AS staff_name, sa.staff_code,
         sda.placement_id, p.client_id, fc.customer_name, sda.status::text AS status, sda.hours_worked,
         sda.source, sda.client_status, sda.client_note, sda.client_action_at, sda.resolution_note, sda.created_at,
         sl.check_in_at AS check_in, sl.check_out_at AS check_out
    FROM staff_daily_attendance sda
    JOIN placements p ON p.id = sda.placement_id
    JOIN staff_applicants sa ON sa.id = sda.staff_id
    LEFT JOIN finance_customers fc ON fc.id = p.client_id
    LEFT JOIN LATERAL (
      SELECT check_in_at, check_out_at FROM shift_logs
       WHERE staff_id = sda.staff_id AND shift_date = sda.attendance_date
         AND (placement_id = sda.placement_id OR placement_id IS NULL)
       ORDER BY check_in_at DESC NULLS LAST LIMIT 1
    ) sl ON true`;

const istClock = (d: Date | null) =>
  d ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : null;

/**
 * The client's confirmation of the days staff mark from the app.
 *
 * Finance approves an invoice — and with it salary — and until now had no
 * evidence the days on it happened. A staff-app day (check-in, a live-in
 * duty, an RM-approved shift) now waits on the client: they approve it, or
 * dispute it with a reason. No answer in 48 hours and the day is DEEMED
 * approved, so a client who never opens the app does not hold up anyone's
 * salary. A disputed day is neither paid nor billed until the RM resolves it.
 *
 * Days HR or the RM enter need none of this: their proof is the muster roll
 * the client signs on paper.
 */
@Injectable()
export class AttendanceApprovalService {
  private readonly logger = new Logger(AttendanceApprovalService.name);

  constructor(private readonly prisma: PrismaService) {}

  private sql<T>(q: string, ...params: unknown[]) {
    return this.prisma.$queryRawUnsafe<T>(q, ...params);
  }

  private async customerFor(userId: string) {
    const c = await this.prisma.financeCustomer.findFirst({ where: { userId }, select: { id: true, customerName: true } });
    if (!c) throw new BadRequestException('No client account is linked to this login.');
    return c;
  }

  private shape(r: DayRow) {
    const deemedAt = r.client_status === 'PENDING'
      ? new Date(new Date(r.created_at).getTime() + DEEMED_AFTER_HOURS * 3_600_000).toISOString()
      : null;
    return {
      id: r.id,
      date: r.date,
      staff_id: r.staff_id,
      staff_name: r.staff_name,
      staff_code: r.staff_code,
      placement_id: r.placement_id,
      client_name: r.customer_name,
      status: r.status,
      hours_worked: r.hours_worked == null ? null : Number(r.hours_worked),
      check_in: r.check_in ? new Date(r.check_in).toISOString() : null,
      check_out: r.check_out ? new Date(r.check_out).toISOString() : null,
      check_in_ist: istClock(r.check_in),
      check_out_ist: istClock(r.check_out),
      source: r.source,
      client_status: r.client_status,
      client_note: r.client_note,
      client_action_at: r.client_action_at ? new Date(r.client_action_at).toISOString() : null,
      /** When an unanswered day becomes DEEMED approved. */
      deemed_at: deemedAt,
      resolution_note: r.resolution_note,
    };
  }

  // ── Client ─────────────────────────────────────────────────────────────

  /**
   * The client's staff-app days. Default: the ones waiting on them. `status`
   * ALL lists every staff-app day in the range (default the last 30 days).
   */
  async listForClient(user: Actor, q: { status?: string; from?: string; to?: string; staff_id?: string }) {
    const c = await this.customerFor(user.id);
    const status = (q.status ?? 'PENDING').toUpperCase();
    const allowed = ['PENDING', 'APPROVED', 'DEEMED', 'DISPUTED', 'APPROVED_PAPER', 'ALL'];
    if (!allowed.includes(status)) throw new BadRequestException(`status must be one of ${allowed.join(', ')}.`);
    const to = q.to ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.sql<DayRow[]>(
      `${DAY_SELECT}
        WHERE p.client_id = $1::uuid AND sda.source = 'STAFF_APP'
          AND ($2 = 'ALL' OR sda.client_status = $2)
          AND sda.attendance_date BETWEEN $3::date AND $4::date
          AND ($5::uuid IS NULL OR sda.staff_id = $5::uuid)
        ORDER BY sda.attendance_date DESC, sa.full_name`,
      c.id, status, from, to, q.staff_id ?? null,
    );
    const [counts] = await this.sql<{ pending: number; disputed: number }[]>(
      `SELECT COUNT(*) FILTER (WHERE sda.client_status = 'PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE sda.client_status = 'DISPUTED')::int AS disputed
         FROM staff_daily_attendance sda JOIN placements p ON p.id = sda.placement_id
        WHERE p.client_id = $1::uuid AND sda.source = 'STAFF_APP'`,
      c.id,
    );
    return { from, to, pending_count: counts?.pending ?? 0, disputed_count: counts?.disputed ?? 0, items: rows.map((r) => this.shape(r)) };
  }

  /** Approve some days (ids) or every waiting day in a range (from/to): the week at once. */
  async approveByClient(user: Actor, body: { ids?: string[]; from?: string; to?: string; staff_id?: string }) {
    const c = await this.customerFor(user.id);
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean).map(String) : [];
    if (!ids.length && !(body.from && body.to)) {
      throw new BadRequestException('Send ids, or from and to (YYYY-MM-DD) to approve every waiting day in between.');
    }
    const updated = await this.sql<{ id: string }[]>(
      `UPDATE staff_daily_attendance sda
          SET client_status = 'APPROVED', client_action_at = NOW(), client_action_by = $1::uuid, updated_at = NOW()
         FROM placements p
        WHERE p.id = sda.placement_id AND p.client_id = $2::uuid
          AND sda.source = 'STAFF_APP' AND sda.client_status IN ('PENDING','DEEMED')
          AND (cardinality($3::uuid[]) = 0 OR sda.id = ANY($3::uuid[]))
          AND ($4::date IS NULL OR sda.attendance_date >= $4::date)
          AND ($5::date IS NULL OR sda.attendance_date <= $5::date)
          AND ($6::uuid IS NULL OR sda.staff_id = $6::uuid)
        RETURNING sda.id`,
      user.id, c.id, ids, body.from ?? null, body.to ?? null, body.staff_id ?? null,
    );
    if (ids.length && updated.length < ids.length) {
      const missing = ids.filter((i) => !updated.some((u) => u.id === i));
      this.logger.warn(`[ATTENDANCE_APPROVE] client ${c.id}: ${missing.length} id(s) not waiting or not theirs`);
    }
    return { approved: updated.length, ids: updated.map((u) => u.id) };
  }

  /**
   * "This day is not right." The day stops being paid or billed and goes to
   * the RM with the client's reason. Refused once the day is on a payslip
   * already released — that is a correction for Finance, via the RM.
   */
  async disputeByClient(user: Actor, id: string, body: { reason?: string; actual?: string }) {
    const c = await this.customerFor(user.id);
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 5) throw new BadRequestException('Say what was wrong (at least 5 characters).');
    const actual = body.actual ? String(body.actual).toUpperCase() : null;
    const actuals = ['ABSENT', 'HALF_DAY', 'LATE', 'LEFT_EARLY', 'OTHER'];
    if (actual && !actuals.includes(actual)) throw new BadRequestException(`actual must be one of ${actuals.join(', ')}.`);

    const [day] = await this.sql<DayRow[]>(`${DAY_SELECT} WHERE sda.id = $1::uuid AND p.client_id = $2::uuid`, id, c.id);
    if (!day) throw new NotFoundException('That day is not one of yours.');
    if (day.source !== 'STAFF_APP') throw new BadRequestException('This day was entered by the office — raise it with your RM.');
    if (!['PENDING', 'DEEMED', 'APPROVED'].includes(day.client_status)) {
      throw new BadRequestException(`This day is already ${day.client_status.toLowerCase().replace('_', ' ')}.`);
    }
    const [released] = await this.sql<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM payroll_records
        WHERE placement_id = $1::uuid AND released_at IS NOT NULL
          AND $2::date BETWEEN period_from AND period_to`,
      day.placement_id, day.date,
    );
    if (released?.n) {
      throw new BadRequestException('This day is already on an approved invoice. Tell your RM — Finance will correct it.');
    }
    await this.sql(
      `UPDATE staff_daily_attendance
          SET client_status = 'DISPUTED', client_action_at = NOW(), client_action_by = $2::uuid,
              client_note = $3, updated_at = NOW()
        WHERE id = $1::uuid`,
      id, user.id, actual ? `${actual}: ${reason}` : reason,
    );
    const [p] = await this.sql<{ rm_id: string | null; assigned_rm_id: string | null }[]>(
      `SELECT p.rm_id, sa.assigned_rm_id FROM placements p JOIN staff_applicants sa ON sa.id = p.staff_id WHERE p.id = $1::uuid`,
      day.placement_id,
    );
    await this.notify(
      [p?.rm_id ?? p?.assigned_rm_id],
      'Client disputed attendance',
      `${c.customerName} says ${day.staff_name}'s attendance on ${day.date} is not right` +
        `${actual ? ` (${actual.toLowerCase().replace('_', ' ')})` : ''}: "${reason}". Resolve it in Attendance disputes — ` +
        `the day is not paid or billed until you do.`,
      'ATTENDANCE_DISPUTED',
      { attendance_id: id, placement_id: day.placement_id, date: day.date },
    );
    const [after] = await this.sql<DayRow[]>(`${DAY_SELECT} WHERE sda.id = $1::uuid`, id);
    return this.shape(after);
  }

  // ── RM ─────────────────────────────────────────────────────────────────

  /** Disputed days on the RM's placements (all of them for BM/Admin), oldest first. */
  async disputesForRm(user: Actor) {
    const mine = user.role === 'RM';
    const rows = await this.sql<DayRow[]>(
      `${DAY_SELECT}
        WHERE sda.client_status = 'DISPUTED'
          AND (NOT $1::boolean OR p.rm_id = $2::uuid OR (p.rm_id IS NULL AND sa.assigned_rm_id = $2::uuid))
        ORDER BY sda.client_action_at`,
      mine, user.id,
    );
    return { total: rows.length, items: rows.map((r) => ({ ...this.shape(r), disputed_at: r.client_action_at })) };
  }

  /**
   * The RM's decision on a disputed day: what the day really was. It counts
   * again from here (as present, absent or a half day), with the decision on
   * record, and the client and staff member are told.
   */
  async resolveByRm(user: Actor, id: string, body: { status?: string; note?: string }) {
    const status = String(body.status ?? '').toUpperCase();
    const allowed: StaffAttendanceStatus[] = ['PRESENT', 'ABSENT', 'HALF_DAY'] as StaffAttendanceStatus[];
    if (!allowed.includes(status as StaffAttendanceStatus)) {
      throw new BadRequestException('status must be PRESENT, ABSENT or HALF_DAY — what the day really was.');
    }
    const note = String(body.note ?? '').trim();
    if (note.length < 5) throw new BadRequestException('Write how it was resolved (at least 5 characters).');
    const [day] = await this.sql<(DayRow & { rm_id: string | null; assigned_rm_id: string | null; client_user: string | null; staff_user: string | null })[]>(
      `SELECT d.*, p2.rm_id, sa2.assigned_rm_id, fc2.user_id AS client_user, sa2.user_id AS staff_user
         FROM (${DAY_SELECT} WHERE sda.id = $1::uuid) d
         JOIN placements p2 ON p2.id = d.placement_id
         JOIN staff_applicants sa2 ON sa2.id = d.staff_id
         LEFT JOIN finance_customers fc2 ON fc2.id = p2.client_id`,
      id,
    );
    if (!day) throw new NotFoundException('Attendance day not found.');
    if (user.role === 'RM' && day.rm_id !== user.id && !(day.rm_id == null && day.assigned_rm_id === user.id)) {
      throw new ForbiddenException('Not your placement.');
    }
    if (day.client_status !== 'DISPUTED') throw new BadRequestException('This day is not disputed.');

    await this.prisma.staffDailyAttendance.update({
      where: { id },
      data: {
        status: status as StaffAttendanceStatus,
        ...(status === 'ABSENT' ? { hoursWorked: null } : {}),
        clientStatus: 'APPROVED',
        resolvedAt: new Date(),
        resolvedBy: user.id,
        resolutionNote: note,
      },
    });
    const word = status === 'HALF_DAY' ? 'a half day' : status.toLowerCase();
    await this.notify([day.client_user], 'Attendance dispute resolved',
      `${day.staff_name} on ${day.date}: recorded as ${word}. ${note}`, 'ATTENDANCE_RESOLVED',
      { attendance_id: id, status });
    await this.notify([day.staff_user], 'Attendance updated',
      `Your attendance on ${day.date} at ${day.customer_name ?? 'the client'} is recorded as ${word}. ${note}`,
      'ATTENDANCE_RESOLVED', { attendance_id: id, status });
    const [after] = await this.sql<DayRow[]>(`${DAY_SELECT} WHERE sda.id = $1::uuid`, id);
    return this.shape(after);
  }

  /**
   * For a client who does not use the app: the RM records their confirmation,
   * with how it was given ("confirmed on the phone"). On record as the RM's,
   * never as the client's own tap.
   */
  async approveOnBehalf(user: Actor, body: { ids?: string[]; note?: string }) {
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean).map(String) : [];
    if (!ids.length) throw new BadRequestException('ids is required.');
    const note = String(body.note ?? '').trim();
    if (note.length < 5) throw new BadRequestException('Say how the client confirmed (at least 5 characters), e.g. "confirmed on the phone".');
    const mine = user.role === 'RM';
    const updated = await this.sql<{ id: string }[]>(
      `UPDATE staff_daily_attendance sda
          SET client_status = 'APPROVED', client_action_at = NOW(), client_action_by = $1::uuid,
              client_note = $2, updated_at = NOW()
         FROM placements p, staff_applicants sa
        WHERE p.id = sda.placement_id AND sa.id = sda.staff_id
          AND sda.id = ANY($3::uuid[]) AND sda.source = 'STAFF_APP' AND sda.client_status IN ('PENDING','DEEMED')
          AND (NOT $4::boolean OR p.rm_id = $1::uuid OR (p.rm_id IS NULL AND sa.assigned_rm_id = $1::uuid))
        RETURNING sda.id`,
      user.id, `RM on behalf of the client: ${note}`, ids, mine,
    );
    return { approved: updated.length, ids: updated.map((u) => u.id) };
  }

  /** Waiting days on the RM's placements, for "approve on behalf" (clients who do not use the app). */
  async pendingForRm(user: Actor, q: { client_id?: string }) {
    const mine = user.role === 'RM';
    const rows = await this.sql<DayRow[]>(
      `${DAY_SELECT}
        WHERE sda.client_status = 'PENDING' AND sda.source = 'STAFF_APP'
          AND ($3::uuid IS NULL OR p.client_id = $3::uuid)
          AND (NOT $1::boolean OR p.rm_id = $2::uuid OR (p.rm_id IS NULL AND sa.assigned_rm_id = $2::uuid))
        ORDER BY fc.customer_name, sda.attendance_date`,
      mine, user.id, q.client_id ?? null,
    );
    return { total: rows.length, items: rows.map((r) => this.shape(r)) };
  }

  // ── Jobs ───────────────────────────────────────────────────────────────

  /** Hourly: a staff-app day the client has not answered in 48 hours is DEEMED approved. */
  @Cron(CronExpression.EVERY_HOUR)
  async deemUnanswered() {
    const rows = await this.sql<{ id: string }[]>(
      `UPDATE staff_daily_attendance
          SET client_status = 'DEEMED', client_action_at = NOW(), updated_at = NOW()
        WHERE client_status = 'PENDING' AND created_at < NOW() - make_interval(hours => $1::int)
        RETURNING id`,
      DEEMED_AFTER_HOURS,
    ).catch((e: Error) => { this.logger.warn(`[ATTENDANCE_DEEMED] ${e.message}`); return []; });
    if (rows.length) this.logger.log(`[ATTENDANCE_DEEMED] ${rows.length} day(s) deemed approved after ${DEEMED_AFTER_HOURS}h`);
    return { deemed: rows.length };
  }

  /**
   * 9 pm IST: one note per client who confirms in the app, listing today's
   * days waiting on them — not a notification per check-in.
   */
  @Cron('0 21 * * *', { timeZone: 'Asia/Kolkata' })
  async remindClients() {
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const rows = await this.sql<(DayRow & { client_user: string | null })[]>(
      `SELECT d.*, fc2.user_id AS client_user
         FROM (${DAY_SELECT}
               WHERE sda.client_status = 'PENDING' AND sda.source = 'STAFF_APP' AND sda.attendance_date = $1::date) d
         JOIN finance_customers fc2 ON fc2.id = d.client_id
        WHERE fc2.user_id IS NOT NULL AND fc2.attendance_proof_mode IN ('APP','BOTH')`,
      today,
    ).catch(() => []);
    const byClient = new Map<string, DayRow[]>();
    for (const r of rows) byClient.set(r.client_user!, [...(byClient.get(r.client_user!) ?? []), r]);
    for (const [userId, days] of byClient) {
      const list = days
        .map((d) => `${d.staff_name}${d.check_in ? ` ${istClock(d.check_in)}${d.check_out ? `–${istClock(d.check_out)}` : ''}` : ''}`)
        .join(', ');
      await this.notify([userId], 'Confirm today\'s attendance',
        `${list}. Tap to confirm — or tell us if something is not right. Unanswered days count as confirmed after ${DEEMED_AFTER_HOURS} hours.`,
        'ATTENDANCE_CONFIRM', { date: today, ids: days.map((d) => d.id) });
    }
    return { clients: byClient.size, days: rows.length };
  }

  private async notify(userIds: (string | null | undefined)[], title: string, body: string, template: string, payload: Record<string, unknown>) {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (!ids.length) return;
    await this.prisma.notification
      .createMany({
        data: ids.map((userId) => ({
          userId, title, body, template,
          payload: payload as Prisma.InputJsonValue,
          channel: 'IN_APP' as const, status: 'SENT', sentAt: new Date(),
        })),
      })
      .catch((e: Error) => this.logger.warn(`notify ${template}: ${e.message}`));
  }
}

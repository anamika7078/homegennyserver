import { BadRequestException, Injectable } from '@nestjs/common';
import { PipelineStage, Placement, Prisma, StaffSeries } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { mapSeriesFromShort, mapSeriesToShort } from '../../common/mappers/staff.mapper';
import { addDays, dbDate, istNow, parseDate } from '../daily-care/care-access.service';
import { MISSED_AFTER_MIN } from '../daily-care/care-plan.service';
import { FAR_METERS, metersBetween } from '../daily-care/checkins.service';
import { OPEN_STATUSES } from '../staff-requests/staff-requests.service';

/**
 * Staff snapshot — docs/STAFF_SNAPSHOT_PLAN.md.
 *
 * One read that pulls together what the RM (web) and the client (app) need
 * for a day: who is free, who is placed where, and whether today's work is
 * going to plan. Nothing here writes; every number comes from tables other
 * modules own (placements, shift_logs, staff_daily_attendance, care_tasks,
 * meal_logs, menu_plans, daily_care_reports, client_instructions).
 *
 * Every source is read once for all placements (`IN (...)`), never per row:
 * the RM page has to stay quick with a few hundred placements.
 */

/** Checked in this many minutes after shift_start → late (amber). */
export const LATE_AFTER_MIN = 15;
/** Not checked in this many minutes after shift_start → red. */
export const NO_SHOW_AFTER_MIN = 60;
/** A placement ending within this many days counts as "free soon". */
const FREE_SOON_DAYS = 7;
/** A sent instruction unread for this long is flagged. */
const INSTRUCTION_UNREAD_MIN = 120;
/** Meal times when neither the menu nor the food profile gives one. */
const DEFAULT_MEAL_TIMES: Record<string, string> = { BREAKFAST: '09:00', LUNCH: '13:30', SNACKS: '17:00', DINNER: '20:30' };
/** A meal not logged this long after its time is "not logged". */
const MEAL_LOG_GRACE_MIN = 60;
/** The daily care report is expected by this time (minutes, IST). */
const REPORT_DUE_MIN = 20 * 60;

const ACTIVE = ['TRIAL', 'CONFIRMED'] as const;
const CARE = new Set<StaffSeries>([StaffSeries.UNSKILLED_CARE, StaffSeries.SKILLED_CARE]);
const SERIES_LABEL: Record<string, string> = {
  UNSKILLED_CARE: 'Caretaker',
  SKILLED_CARE: 'Skilled Caretaker',
  COOK: 'Cook',
  MAID: 'Maid',
  DRIVER: 'Driver',
};

export type DayStatus = 'RED' | 'AMBER' | 'GREEN' | 'NOT_STARTED';
export type Attendance =
  | 'ON_TIME' | 'LATE' | 'CHECKED_IN' | 'NOT_STARTED' | 'NOT_IN_YET' | 'NO_SHOW' | 'ABSENT' | 'ON_LEAVE';

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
/** HH:MM (IST) of an instant. */
const istHhmm = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);
const dateStr = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const firstName = (n: string | null | undefined) => (n ?? '').trim().split(/\s+/)[0] || null;

interface PlacementRow extends Placement {
  staff: { id: string; fullName: string | null; series: StaffSeries | null; mobile: string; assignedRmId: string | null };
}

/** Everything known about one placement's day, before it is shaped for the RM or the client. */
interface DayFacts {
  placement: PlacementRow;
  client: { id: string; name: string; city: string | null } | null;
  attendance: Attendance;
  checkIn: string | null;
  checkOut: string | null;
  lateBy: number | null;
  far: boolean | null;
  distanceM: number | null;
  care: { total: number; done: number; missed: number; missedMeds: number; vitalAlerts: number; next: string | null } | null;
  cook: { planned: number; due: number; logged: number; missingDue: string[]; rating7d: number | null } | null;
  reportFilled: boolean | null;
  instructionsUnread: number;
  instructionsRefusedOpen: number;
  status: DayStatus;
  flags: string[];
}

@Injectable()
export class SnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  // ── RM ────────────────────────────────────────────────────────────────────

  /**
   * RM: their staff and placements. BM: the branch. Admin: all (or ?branch_id).
   * `date` (YYYY-MM-DD, IST) picks the day for attendance and work; staff
   * availability and the list of deployments are always as of now.
   */
  async rmSnapshot(user: AuthUser, q: { date?: string; series?: string; branch_id?: string }) {
    const date = q.date ? parseDate(q.date) : istNow().date;
    const series = q.series ? mapSeriesFromShort(q.series) : undefined;
    const branchId = user.role === 'BM' && user.branchId ? user.branchId : user.role === 'ADMIN' ? q.branch_id : undefined;

    const staffWhere: Prisma.StaffApplicantWhereInput = {
      deletedAt: null,
      pipelineStage: { not: PipelineStage.TERMINAL },
      ...(user.role === 'RM' ? { assignedRmId: user.id } : {}),
      ...(branchId ? { branchId } : {}),
      ...(series ? { series } : {}),
    };
    // Placement has no staff relation in Prisma, so "the RM's staff" and the
    // series filter go through staff ids. Terminal staff count here: an
    // ENROLLED/CONDITIONAL exit keeps its placements.
    const scopedStaffIds =
      user.role === 'RM' || series
        ? (await this.prisma.staffApplicant.findMany({
            where: { deletedAt: null, ...(user.role === 'RM' ? { assignedRmId: user.id } : {}), ...(series ? { series } : {}) },
            select: { id: true },
          })).map((x) => x.id)
        : null;
    const placementWhere: Prisma.PlacementWhereInput = {
      status: { in: [...ACTIVE] },
      ...(branchId ? { branchId } : {}),
      ...(user.role === 'RM'
        ? series
          ? { staffId: { in: scopedStaffIds! } }
          : { OR: [{ rmId: user.id }, { staffId: { in: scopedStaffIds! } }] }
        : series
          ? { staffId: { in: scopedStaffIds! } }
          : {}),
    };

    const [staff, placementRows] = await Promise.all([
      this.prisma.staffApplicant.findMany({
        where: staffWhere,
        select: {
          id: true, fullName: true, series: true, pipelineStage: true, languageTier: true, mobile: true,
          metadata: true, branch: { select: { name: true, city: true } },
        },
      }),
      this.prisma.placement.findMany({ where: placementWhere, orderBy: { createdAt: 'asc' } }),
    ]);
    const placements = await this.withStaff(placementRows);

    const availability = await this.availability(staff, date);
    const facts = await this.dayFacts(placements, date, { forClient: false });
    const rank: Record<DayStatus, number> = { RED: 0, AMBER: 1, NOT_STARTED: 2, GREEN: 3 };
    facts.sort((a, b) => rank[a.status] - rank[b.status]);

    const today = istNow().date;
    const soon = addDays(today, FREE_SOON_DAYS);
    const trialsEnding = placements.filter(
      (p) => p.status === 'TRIAL' && p.trialEndDate && dateStr(p.trialEndDate)! >= today && dateStr(p.trialEndDate)! <= soon,
    ).length;

    return {
      date,
      generated_at: new Date().toISOString(),
      rules: {
        late_after_min: LATE_AFTER_MIN,
        no_show_after_min: NO_SHOW_AFTER_MIN,
        far_meters: FAR_METERS,
        free_soon_days: FREE_SOON_DAYS,
      },
      summary: {
        availability: availability.counts,
        deployment: {
          active: placements.length,
          permanent: placements.filter((p) => p.placementType === 'PERMANENT').length,
          temporary: placements.filter((p) => p.placementType === 'TEMPORARY').length,
          trial: placements.filter((p) => p.status === 'TRIAL').length,
          trials_ending_7d: trialsEnding,
        },
        alignment: {
          RED: facts.filter((f) => f.status === 'RED').length,
          AMBER: facts.filter((f) => f.status === 'AMBER').length,
          GREEN: facts.filter((f) => f.status === 'GREEN').length,
          NOT_STARTED: facts.filter((f) => f.status === 'NOT_STARTED').length,
        },
      },
      staff: availability.rows,
      deployments: facts.map((f) => this.rmRow(f)),
    };
  }

  private rmRow(f: DayFacts) {
    const p = f.placement;
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    return {
      placement_id: p.id,
      staff: { id: p.staff.id, name: p.staff.fullName, series: mapSeriesToShort(p.staff.series), phone: p.staff.mobile },
      client: f.client,
      type: p.placementType,
      visit: meta.visit_type === 'ONE_TIME' ? 'ONE_TIME' : 'REGULAR',
      status: p.status,
      since: dateStr(p.trialStartDate) ?? dateStr(p.createdAt),
      trial_end: p.status === 'TRIAL' ? dateStr(p.trialEndDate) : null,
      exit_date: dateStr(p.exitDate),
      shift_start: p.shiftStart,
      shift_hours: Number(p.shiftHours),
      today: {
        attendance: f.attendance,
        check_in: f.checkIn,
        check_out: f.checkOut,
        late_by_min: f.lateBy,
        far: f.far,
        distance_m: f.distanceM,
        care: f.care
          ? { total: f.care.total, done: f.care.done, missed: f.care.missed, missed_meds: f.care.missedMeds, vital_alerts: f.care.vitalAlerts }
          : null,
        cook: f.cook
          ? { meals_planned: f.cook.planned, meals_due: f.cook.due, meals_logged: f.cook.logged, rating_7d: f.cook.rating7d }
          : null,
        report_filled: f.reportFilled,
        instructions: { unread: f.instructionsUnread, refused_open: f.instructionsRefusedOpen },
      },
      status_today: f.status,
      flags: f.flags,
    };
  }

  /**
   * One state per staff member, same rules as the staff-request shortlist
   * (StaffRequestsService.candidates): S5 and no active placement = available;
   * hourly only = partly; a permanent placement = deployed. Leave/absence for
   * the day and open holds override; deployed ending within a week = free soon.
   * Staff not at S5 are only counted, by stage.
   */
  private async availability(
    staff: {
      id: string; fullName: string | null; series: StaffSeries | null; pipelineStage: PipelineStage;
      languageTier: string | null; mobile: string; metadata: Prisma.JsonValue; branch: { name: string; city: string } | null;
    }[],
    date: string,
  ) {
    const ids = staff.map((s) => s.id);
    const [active, leave, holds, lastExit] = await Promise.all([
      this.prisma.placement.findMany({
        where: { staffId: { in: ids }, status: { in: [...ACTIVE] } },
        select: { staffId: true, placementType: true, status: true, trialEndDate: true, exitDate: true, clientId: true },
      }),
      this.prisma.staffDailyAttendance.findMany({
        where: { staffId: { in: ids }, attendanceDate: dbDate(date), status: { in: ['LEAVE', 'ABSENT'] } },
        select: { staffId: true, status: true },
      }),
      this.prisma.stageHold.findMany({
        where: { staffId: { in: ids }, releasedAt: null, kind: 'HOLD' },
        select: { staffId: true, stage: true },
      }),
      this.prisma.placement.groupBy({
        by: ['staffId'],
        where: { staffId: { in: ids }, exitDate: { not: null } },
        _max: { exitDate: true },
      }),
    ]);

    const byStaff = new Map<string, typeof active>();
    for (const p of active) byStaff.set(p.staffId, [...(byStaff.get(p.staffId) ?? []), p]);
    const leaveOf = new Map(leave.map((l) => [l.staffId, l.status]));
    const heldAt = new Map(holds.map((h) => [h.staffId, h.stage]));
    const exitOf = new Map(lastExit.map((e) => [e.staffId, e._max.exitDate]));
    const soon = addDays(istNow().date, FREE_SOON_DAYS);

    const counts = {
      available: 0, partly_available: 0, deployed: 0, free_soon: 0, on_leave: 0, on_hold: 0,
      in_pipeline: {} as Record<string, number>,
    };
    const rows: Record<string, unknown>[] = [];
    for (const s of staff) {
      if (s.pipelineStage !== PipelineStage.S5_DEPLOY) {
        counts.in_pipeline[s.pipelineStage] = (counts.in_pipeline[s.pipelineStage] ?? 0) + 1;
        continue;
      }
      const mine = byStaff.get(s.id) ?? [];
      const permanent = mine.find((p) => p.placementType === 'PERMANENT');
      let state: string;
      let endsOn: string | null = null;
      if (leaveOf.has(s.id)) state = 'ON_LEAVE';
      else if (heldAt.has(s.id) && !mine.length) state = 'ON_HOLD';
      else if (permanent) {
        endsOn = dateStr(permanent.exitDate) ?? (permanent.status === 'TRIAL' ? dateStr(permanent.trialEndDate) : null);
        state = endsOn && endsOn <= soon ? 'FREE_SOON' : 'DEPLOYED';
      } else if (mine.length) state = 'PARTLY_AVAILABLE';
      else state = 'AVAILABLE';

      const key = state.toLowerCase() as keyof typeof counts;
      (counts[key] as number) += 1;
      const meta = (s.metadata ?? {}) as Record<string, unknown>;
      rows.push({
        staff_id: s.id,
        name: s.fullName,
        series: mapSeriesToShort(s.series),
        language_tier: s.languageTier,
        gender: meta.gender ?? null,
        phone: s.mobile,
        branch: s.branch?.name ?? null,
        city: (meta.city as string | undefined) ?? s.branch?.city ?? null,
        state,
        placements: mine.length,
        hourly_placements: mine.filter((p) => p.placementType === 'TEMPORARY').length,
        ends_on: endsOn,
        free_since: state === 'AVAILABLE' ? dateStr(exitOf.get(s.id) ?? null) : null,
        leave_today: leaveOf.get(s.id) ?? null,
        on_hold_at: heldAt.get(s.id) ?? null,
      });
    }
    const order: Record<string, number> = { AVAILABLE: 0, PARTLY_AVAILABLE: 1, FREE_SOON: 2, ON_LEAVE: 3, ON_HOLD: 4, DEPLOYED: 5 };
    rows.sort((a, b) => order[a.state as string] - order[b.state as string] || String(a.name ?? '').localeCompare(String(b.name ?? '')));
    return { counts, rows };
  }

  // ── Client ────────────────────────────────────────────────────────────────

  /**
   * The client app's "today at home": one card per staff member placed with
   * the logged-in client, their last 7 days, and the client's own open
   * requests and replacements. No staff phone, Aadhaar or address here.
   */
  async clientSnapshot(userId: string, q: { date?: string }) {
    const customer = await this.prisma.financeCustomer.findFirst({ where: { userId }, select: { id: true } });
    if (!customer) throw new BadRequestException('No client account is linked to this login.');
    const date = q.date ? parseDate(q.date) : istNow().date;

    const placements = await this.withStaff(
      await this.prisma.placement.findMany({
        where: { clientId: customer.id, status: { in: [...ACTIVE] } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const facts = await this.dayFacts(placements, date, { forClient: true });

    // Last 7 days, oldest first: worked (a check-in, or marked present) / absent / on leave / nothing recorded.
    const from = addDays(date, -6);
    const ids = placements.map((p) => p.id);
    const [shifts, marks, requests, replacements] = await Promise.all([
      this.prisma.shiftLog.findMany({
          where: { placementId: { in: ids }, shiftDate: { gte: dbDate(from), lte: dbDate(date) }, checkInAt: { not: null } },
          select: { placementId: true, shiftDate: true },
        }),
      this.prisma.staffDailyAttendance.findMany({
          where: { placementId: { in: ids }, attendanceDate: { gte: dbDate(from), lte: dbDate(date) } },
          select: { placementId: true, attendanceDate: true, status: true },
        }),
      this.prisma.staffRequest.findMany({
        where: { clientId: customer.id, status: { in: [...OPEN_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, requestNo: true, series: true, status: true, startDate: true, startTime: true, visitType: true, createdAt: true },
      }),
      this.prisma.$queryRaw<{ id: string; placement_id: string; status: string; created_at: Date }[]>`
        SELECT id, placement_id, status, created_at FROM replacement_requests
         WHERE client_id = ${customer.id}::uuid AND status = 'UNDER_RM_REVIEW'
         ORDER BY created_at DESC`.catch(() => []),
    ]);
    const worked = new Set(shifts.map((s) => `${s.placementId}|${dateStr(s.shiftDate)}`));
    const marked = new Map(marks.map((m) => [`${m.placementId}|${dateStr(m.attendanceDate)}`, m.status as string]));

    return {
      date,
      generated_at: new Date().toISOString(),
      staff: facts.map((f) => {
        const p = f.placement;
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        const days: { date: string; attendance: string }[] = [];
        for (let i = 0; i < 7; i++) {
          const d = addDays(from, i);
          const m = marked.get(`${p.id}|${d}`);
          days.push({
            date: d,
            attendance:
              m === 'LEAVE' ? 'LEAVE' : m === 'ABSENT' ? 'ABSENT'
                : worked.has(`${p.id}|${d}`) || (m && m !== 'ABSENT' && m !== 'LEAVE') ? 'PRESENT'
                  : 'NONE',
          });
        }
        const name = firstName(p.staff.fullName);
        return {
          placement_id: p.id,
          staff: {
            id: p.staff.id,
            first_name: name,
            series: mapSeriesToShort(p.staff.series),
            series_label: p.staff.series ? SERIES_LABEL[p.staff.series] ?? p.staff.series : null,
            photo_url: `/client/staff/${p.staff.id}/photo`,
            profile_url: `/client/staff/${p.staff.id}/profile`,
          },
          deployment: {
            type: p.placementType,
            visit: meta.visit_type === 'ONE_TIME' ? 'ONE_TIME' : 'REGULAR',
            status: p.status,
            since: dateStr(p.trialStartDate) ?? dateStr(p.createdAt),
            trial_ends: p.status === 'TRIAL' ? dateStr(p.trialEndDate) : null,
            shift_start: p.shiftStart,
            shift_hours: Number(p.shiftHours),
          },
          today: {
            attendance: f.attendance,
            check_in: f.checkIn,
            check_out: f.checkOut,
            late_by_min: f.lateBy,
            work: f.care ? { done: f.care.done, total: f.care.total, missed: f.care.missed, next: f.care.next } : null,
            meals: f.cook ? { planned: f.cook.planned, logged: f.cook.logged, due: f.cook.due, not_logged: f.cook.missingDue } : null,
            report_filled: f.reportFilled,
            unread_instructions: f.instructionsUnread,
          },
          status_today: f.status,
          message: this.clientMessage(name ?? 'Your staff', f),
          last_7_days: days,
        };
      }),
      requests: requests.map((r) => ({
        id: r.id,
        request_no: r.requestNo,
        series: mapSeriesToShort(r.series),
        status: r.status,
        visit_type: r.visitType,
        start_date: dateStr(r.startDate),
        start_time: r.startTime,
        created_at: r.createdAt,
      })),
      replacements: replacements.map((r) => ({ id: r.id, placement_id: r.placement_id, status: r.status, created_at: r.created_at })),
    };
  }

  /** Placements with the few staff fields the snapshot shows (one query for all). */
  private async withStaff(rows: Placement[]): Promise<PlacementRow[]> {
    const staff = await this.prisma.staffApplicant.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
      select: { id: true, fullName: true, series: true, mobile: true, assignedRmId: true },
    });
    const byId = new Map(staff.map((x) => [x.id, x]));
    return rows
      .filter((r) => byId.has(r.staffId))
      .map((r) => ({ ...r, staff: byId.get(r.staffId)! }));
  }

  /** One plain-English line for the client's card. */
  private clientMessage(name: string, f: DayFacts): string {
    const parts: string[] = [];
    switch (f.attendance) {
      case 'ON_TIME':
      case 'CHECKED_IN':
        parts.push(`${name} checked in at ${f.checkIn}`);
        break;
      case 'LATE':
        parts.push(`${name} checked in at ${f.checkIn} (${f.lateBy} min late)`);
        break;
      case 'NOT_STARTED':
        parts.push(f.placement.shiftStart ? `${name} is due at ${f.placement.shiftStart}` : `${name} has not checked in yet`);
        break;
      case 'NOT_IN_YET':
        parts.push(`${name} was due at ${f.placement.shiftStart} and has not checked in yet`);
        break;
      case 'NO_SHOW':
        parts.push(`${name} has not checked in today`);
        break;
      case 'ABSENT':
        parts.push(`${name} is absent today`);
        break;
      case 'ON_LEAVE':
        parts.push(`${name} is on leave today`);
        break;
    }
    if (f.checkOut) parts[0] += `, left at ${f.checkOut}`;
    if (f.care && f.care.total) parts.push(`${f.care.done} of ${f.care.total} tasks done`);
    if (f.cook && f.cook.planned) parts.push(`${f.cook.logged} of ${f.cook.planned} meals made`);
    return parts.join(' · ');
  }

  // ── Shared: one day of each placement ─────────────────────────────────────

  private async dayFacts(placements: PlacementRow[], date: string, opts: { forClient: boolean }): Promise<DayFacts[]> {
    if (!placements.length) return [];
    const now = istNow();
    // Minutes into `date` it is now: past days are over, future days have not begun.
    const nowMin = date < now.date ? 24 * 60 : date > now.date ? -1 : now.minutes;
    const ids = placements.map((p) => p.id);
    const staffIds = [...new Set(placements.map((p) => p.staffId))];
    const clientIds = [...new Set(placements.map((p) => p.clientId))];
    const requestIds = placements
      .map((p) => ((p.metadata ?? {}) as Record<string, unknown>).staff_request_id)
      .filter((x): x is string => typeof x === 'string');
    const careIds = placements.filter((p) => p.staff.series && CARE.has(p.staff.series)).map((p) => p.id);
    const cookIds = placements.filter((p) => p.staff.series === StaffSeries.COOK).map((p) => p.id);
    const day = dbDate(date);

    const [clients, requests, shifts, marks, tasks, reports, menus, meals, profiles, ratings, instr] = await Promise.all([
      this.prisma.financeCustomer.findMany({ where: { id: { in: clientIds } }, select: { id: true, customerName: true, city: true, lat: true, lng: true } }),
      this.prisma.staffRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, lat: true, lng: true } }),
      this.prisma.shiftLog.findMany({
        where: { placementId: { in: ids }, shiftDate: day },
        select: { placementId: true, checkInAt: true, checkOutAt: true, checkInLat: true, checkInLng: true },
      }),
      this.prisma.staffDailyAttendance.findMany({
        where: { staffId: { in: staffIds }, attendanceDate: day },
        select: { staffId: true, placementId: true, status: true },
      }),
      this.prisma.careTask.findMany({
        where: { placementId: { in: careIds }, taskDate: day },
        select: { placementId: true, status: true, sourceType: true, scheduledTime: true, title: true, outOfRange: true },
      }),
      this.prisma.dailyCareReport.findMany({ where: { placementId: { in: careIds }, reportDate: day }, select: { placementId: true } }),
      this.prisma.menuPlan.findMany({
        where: { placementId: { in: cookIds }, menuDate: day, status: { in: ['PLANNED', 'APPROVED'] } },
        select: { placementId: true, meal: true, mealTime: true },
      }),
      this.prisma.mealLog.findMany({ where: { placementId: { in: cookIds }, mealDate: day }, select: { placementId: true, meal: true } }),
      this.prisma.foodProfile.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, mealTimes: true } }),
      this.prisma.mealFeedback.findMany({
        where: { mealLog: { placementId: { in: cookIds } }, createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
        select: { rating: true, mealLog: { select: { placementId: true } } },
      }),
      this.prisma.clientInstruction.findMany({
        where: { placementId: { in: ids }, OR: [{ status: 'SENT' }, { status: 'REFUSED', rmDecision: null }] },
        select: { placementId: true, status: true, createdAt: true },
      }),
    ]);

    const clientOf = new Map(clients.map((c) => [c.id, c]));
    const requestOf = new Map(requests.map((r) => [r.id, r]));
    const shiftOf = new Map(shifts.map((s) => [s.placementId!, s]));
    const group = <T extends { placementId: string | null }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) if (x.placementId) m.set(x.placementId, [...(m.get(x.placementId) ?? []), x]);
      return m;
    };
    const tasksOf = group(tasks);
    const reported = new Set(reports.map((r) => r.placementId));
    const menusOf = group(menus);
    const loggedOf = group(meals);
    const mealTimesOf = new Map(profiles.map((f) => [f.clientId, (f.mealTimes ?? {}) as Record<string, string>]));
    const ratingsOf = new Map<string, number[]>();
    for (const r of ratings) ratingsOf.set(r.mealLog.placementId, [...(ratingsOf.get(r.mealLog.placementId) ?? []), r.rating]);
    const instrOf = group(instr);

    return placements.map((p) => {
      const flags: string[] = [];
      let red = false;
      let amber = false;
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      const c = clientOf.get(p.clientId);
      const sr = typeof meta.staff_request_id === 'string' ? requestOf.get(meta.staff_request_id) : undefined;
      const home =
        c?.lat != null && c?.lng != null ? { lat: Number(c.lat), lng: Number(c.lng) }
          : sr?.lat != null && sr?.lng != null ? { lat: Number(sr.lat), lng: Number(sr.lng) }
            : null;

      // A one-time visit only has its own day.
      const visitDate = meta.visit_type === 'ONE_TIME' ? (meta.visit_date as string | undefined) : undefined;
      const expectedToday = !visitDate || visitDate === date;

      // ── Attendance ──
      const shift = shiftOf.get(p.id);
      const mark = marks.find((m) => m.placementId === p.id) ?? marks.find((m) => m.staffId === p.staffId && m.status === 'LEAVE');
      const startMin = p.shiftStart ? minutesOf(p.shiftStart) : null;
      let attendance: Attendance;
      let lateBy: number | null = null;
      if (shift?.checkInAt) {
        const inMin = minutesOf(istHhmm(shift.checkInAt));
        if (startMin !== null) {
          lateBy = Math.max(0, inMin - startMin);
          attendance = lateBy > LATE_AFTER_MIN ? 'LATE' : 'ON_TIME';
          if (attendance === 'LATE') {
            amber = true;
            flags.push(`Checked in ${lateBy} min late`);
          } else lateBy = null;
        } else attendance = 'CHECKED_IN';
      } else if (mark?.status === 'LEAVE') {
        attendance = 'ON_LEAVE';
        red = true;
        flags.push('On leave today');
      } else if (mark?.status === 'ABSENT') {
        attendance = 'ABSENT';
        red = true;
        flags.push('Absent today');
      } else if (!expectedToday) {
        attendance = 'NOT_STARTED';
      } else if (startMin !== null && nowMin >= startMin + NO_SHOW_AFTER_MIN) {
        attendance = 'NO_SHOW';
        red = true;
        flags.push(`Not checked in (due ${p.shiftStart})`);
      } else if (startMin !== null && nowMin > startMin + LATE_AFTER_MIN) {
        attendance = 'NOT_IN_YET';
        amber = true;
        flags.push(`Not in yet (due ${p.shiftStart})`);
      } else {
        attendance = 'NOT_STARTED';
        // A day that is over with no check-in and no known start is still worth a look.
        if (startMin === null && nowMin >= 24 * 60) {
          amber = true;
          flags.push('No check-in recorded');
        }
      }

      // ── Where they checked in ──
      let far: boolean | null = null;
      let distanceM: number | null = null;
      if (shift?.checkInAt && shift.checkInLat != null && shift.checkInLng != null && home) {
        distanceM = metersBetween(home, { lat: Number(shift.checkInLat), lng: Number(shift.checkInLng) });
        far = distanceM > FAR_METERS;
        if (far) {
          amber = true;
          flags.push(`Checked in ${distanceM} m from home`);
        }
      }

      // ── Care work ──
      let care: DayFacts['care'] = null;
      let reportFilled: boolean | null = null;
      if (p.staff.series && CARE.has(p.staff.series)) {
        const ts = tasksOf.get(p.id) ?? [];
        // PENDING past its grace is missed even before the sweep marks it so.
        const isMissed = (t: (typeof ts)[number]) =>
          t.status === 'MISSED' || (t.status === 'PENDING' && minutesOf(t.scheduledTime) + MISSED_AFTER_MIN < nowMin);
        const missed = ts.filter(isMissed);
        const missedMeds = missed.filter((t) => t.sourceType === 'MEDICATION').length;
        const vitalAlerts = ts.filter((t) => t.outOfRange).length;
        const next = ts
          .filter((t) => t.status === 'PENDING' && !isMissed(t))
          .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime))[0];
        care = {
          total: ts.length,
          done: ts.filter((t) => t.status === 'DONE').length,
          missed: missed.length,
          missedMeds,
          vitalAlerts,
          next: next ? `${next.title} at ${next.scheduledTime}` : null,
        };
        if (missedMeds) {
          red = true;
          flags.push(`${missedMeds} medicine dose(s) missed`);
        }
        if (missed.length - missedMeds > 0) {
          amber = true;
          flags.push(`${missed.length - missedMeds} task(s) missed`);
        }
        if (vitalAlerts) {
          red = true;
          flags.push(`${vitalAlerts} reading(s) out of range`);
        }
        reportFilled = reported.has(p.id);
        if (!reportFilled && nowMin >= REPORT_DUE_MIN && expectedToday && attendance !== 'ON_LEAVE' && attendance !== 'ABSENT') {
          amber = true;
          flags.push("Today's care report not filled");
        }
      }

      // ── Cook work ──
      let cook: DayFacts['cook'] = null;
      if (p.staff.series === StaffSeries.COOK) {
        const plans = menusOf.get(p.id) ?? [];
        const logged = new Set((loggedOf.get(p.id) ?? []).map((m) => m.meal));
        const times = mealTimesOf.get(p.clientId) ?? {};
        const due = plans.filter((m) => {
          const t = m.mealTime ?? times[m.meal] ?? DEFAULT_MEAL_TIMES[m.meal];
          return t ? minutesOf(t) + MEAL_LOG_GRACE_MIN < nowMin : false;
        });
        const missingDue = due.filter((m) => !logged.has(m.meal)).map((m) => m.meal);
        const rs = ratingsOf.get(p.id) ?? [];
        const rating7d = rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 10) / 10 : null;
        cook = { planned: plans.length, due: due.length, logged: plans.filter((m) => logged.has(m.meal)).length, missingDue, rating7d };
        if (missingDue.length) {
          amber = true;
          flags.push(`Meal not logged: ${missingDue.map((m) => m.toLowerCase()).join(', ')}`);
        }
        if (rating7d !== null && rating7d < 3) {
          amber = true;
          flags.push(`Rating ${rating7d}/5 this week`);
        }
      }

      // ── Instructions from the client ──
      const ins = instrOf.get(p.id) ?? [];
      const unread = ins.filter((i) => i.status === 'SENT').length;
      const unreadLong = ins.filter((i) => i.status === 'SENT' && Date.now() - i.createdAt.getTime() > INSTRUCTION_UNREAD_MIN * 60_000).length;
      const refusedOpen = ins.filter((i) => i.status === 'REFUSED').length;
      if (unreadLong) {
        amber = true;
        flags.push(`${unreadLong} instruction(s) unread for 2 h+`);
      }
      if (refusedOpen && !opts.forClient) {
        red = true;
        flags.push(`${refusedOpen} refused instruction(s) to decide`);
      }

      const status: DayStatus = red ? 'RED' : amber ? 'AMBER' : attendance === 'NOT_STARTED' ? 'NOT_STARTED' : 'GREEN';
      return {
        placement: p,
        client: c ? { id: c.id, name: c.customerName, city: c.city } : null,
        attendance,
        checkIn: shift?.checkInAt ? istHhmm(shift.checkInAt) : null,
        checkOut: shift?.checkOutAt ? istHhmm(shift.checkOutAt) : null,
        lateBy,
        far,
        distanceM,
        care,
        cook,
        reportFilled,
        instructionsUnread: unread,
        instructionsRefusedOpen: opts.forClient ? 0 : refusedOpen,
        status,
        flags,
      };
    });
  }
}

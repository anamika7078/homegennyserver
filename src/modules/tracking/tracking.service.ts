import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Placement, Prisma, ShiftLog } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentsService } from '../documents/documents.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { addDays, dbDate, istNow, parseDate } from '../daily-care/care-access.service';
import { FAR_METERS, metersBetween } from '../daily-care/checkins.service';

/**
 * Check-in / check-out, location during the shift, and what the client sees of
 * the staff in their home — docs/STAFF_TRACKING_AND_CLIENT_VISIBILITY_PLAN.md.
 *
 * A shift is one row per staff, placement and IST day (shift_logs). While it is
 * open the staff app sends its location about every 5 minutes
 * (staff_location_pings); the client sees it only while the shift is open.
 */

/** How often the app should send its location, in seconds. The app takes it from each response. */
export const LOCATION_INTERVAL_SEC = 300;
/** Points closer together than this are dropped. */
const MIN_GAP_MS = 2 * 60_000;
/** No point for this long during a shift → "location not updated". */
const STALE_MS = 20 * 60_000;
const KEEP_DAYS = 30;
const MAX_POINTS = 50;

const ACTIVE = ['TRIAL', 'CONFIRMED'] as const;

const SERIES_LABEL: Record<string, string> = {
  UNSKILLED_CARE: 'Caretaker (UC)',
  SKILLED_CARE: 'Skilled Caretaker (SC)',
  COOK: 'Cook',
  MAID: 'Maid',
  DRIVER: 'Driver',
};
const LANGUAGE_TIER_LABEL: Record<string, string> = {
  T1: 'Tier 1',
  T2: 'Tier 2',
  T3: 'Tier 3',
  T4: 'Tier 4',
};
const PLACEMENT_STATUS_LABEL: Record<string, string> = {
  TRIAL: 'On trial',
  CONFIRMED: 'Active',
  EXITED: 'Ended',
  TERMINATED: 'Ended',
};
const TRAINED_STAGES = ['S4_AGREEMENTS', 'S5_DEPLOY'];

type Point = { lat: number; lng: number };
type Home = Point & { source: 'CLIENT' | 'STAFF_REQUEST' };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function optPoint(lat: unknown, lng: unknown, field = 'latitude/longitude'): Point | null {
  const a = num(lat);
  const b = num(lng);
  if (a === null && b === null) return null;
  if (a === null || b === null || a < -90 || a > 90 || b < -180 || b > 180) {
    throw new BadRequestException(`${field} must be a real location (send both).`);
  }
  return { lat: a, lng: b };
}
/** 8:02 AM, in IST. */
function clock(d: Date): string {
  return d.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
}
function howFar(m: number | null): string | null {
  if (m === null) return null;
  if (m <= FAR_METERS) return 'at home';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km from home` : `${m} m from home`;
}
function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} m`;
}
function firstName(full: string | null | undefined): string {
  return (full ?? '').trim().split(/\s+/)[0] || 'Your staff';
}
function ageFrom(dob: Date | null): number | null {
  if (!dob) return null;
  const today = istNow().date;
  const [y, m, d] = today.split('-').map(Number);
  let age = y - dob.getUTCFullYear();
  if (m < dob.getUTCMonth() + 1 || (m === dob.getUTCMonth() + 1 && d < dob.getUTCDate())) age--;
  return age;
}
function meta(p: { metadata: Prisma.JsonValue }): Record<string, unknown> {
  return (p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) as Record<string, unknown>;
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  // ── helpers ───────────────────────────────────────────────────────────────

  private async staffOf(userId: string) {
    const staff = await this.prisma.staffApplicant.findFirst({ where: { userId, deletedAt: null } });
    if (!staff) throw new BadRequestException('No staff record linked to this account');
    return staff;
  }

  /** The client's saved home, else the pin from the staff request the placement filled. */
  private async homeOf(p: Pick<Placement, 'clientId' | 'metadata'>): Promise<Home | null> {
    const c = await this.prisma.financeCustomer.findUnique({ where: { id: p.clientId }, select: { lat: true, lng: true } });
    if (c?.lat != null && c?.lng != null) return { lat: Number(c.lat), lng: Number(c.lng), source: 'CLIENT' };
    const srId = meta(p).staff_request_id;
    if (typeof srId === 'string') {
      const sr = await this.prisma.staffRequest.findUnique({ where: { id: srId }, select: { lat: true, lng: true } }).catch(() => null);
      if (sr?.lat != null && sr?.lng != null) return { lat: Number(sr.lat), lng: Number(sr.lng), source: 'STAFF_REQUEST' };
    }
    return null;
  }

  /**
   * Placements the staff member can check in at today: trial or confirmed.
   * A one-time visit only on its own day.
   */
  private async checkInable(staffId: string, today: string) {
    const all = await this.prisma.placement.findMany({
      where: { staffId, status: { in: [...ACTIVE] } },
      orderBy: { createdAt: 'desc' },
    });
    const ok = all.filter((p) => {
      const m = meta(p);
      if (m.visit_type !== 'ONE_TIME') return true;
      const day = (m.visit_date as string | undefined) ?? (p.trialStartDate ? p.trialStartDate.toISOString().slice(0, 10) : undefined);
      return day === today;
    });
    return { ok, all };
  }

  private async clientsById(ids: string[]) {
    const rows = ids.length
      ? await this.prisma.financeCustomer.findMany({
          where: { id: { in: [...new Set(ids)] } },
          select: { id: true, customerName: true, address: true, userId: true },
        })
      : [];
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async notify(userIds: (string | null | undefined)[], title: string, body: string, template: string, payload: Record<string, unknown>) {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (!ids.length) return;
    await this.prisma.notification
      .createMany({
        data: ids.map((userId) => ({
          userId,
          title,
          body,
          template,
          payload: payload as Prisma.InputJsonValue,
          channel: 'IN_APP' as const,
          status: 'SENT',
          sentAt: new Date(),
        })),
      })
      .catch((e) => this.logger.warn(`notify ${template} failed: ${e.message}`));
  }

  /** Today's open shift (checked in, not out), at any of the staff member's placements. */
  private openShift(staffId: string, day: Date, placementId?: string) {
    return this.prisma.shiftLog.findFirst({
      where: { staffId, shiftDate: day, checkInAt: { not: null }, checkOutAt: null, ...(placementId ? { placementId } : {}) },
      orderBy: { checkInAt: 'desc' },
    });
  }

  // ── staff app ─────────────────────────────────────────────────────────────

  /** Where the staff member can check in today — for the app's picker. */
  async placementsForStaff(userId: string) {
    const staff = await this.staffOf(userId);
    const today = istNow().date;
    const { ok } = await this.checkInable(staff.id, today);
    const clients = await this.clientsById(ok.map((p) => p.clientId));
    const open = await this.openShift(staff.id, dbDate(today));
    const items = await Promise.all(ok.map(async (p) => {
      const c = clients.get(p.clientId);
      const home = await this.homeOf(p);
      const shift = await this.prisma.shiftLog.findFirst({ where: { staffId: staff.id, placementId: p.id, shiftDate: dbDate(today) } });
      return {
        placement_id: p.id,
        client_name: c?.customerName ?? 'Client',
        address: c?.address ?? null,
        home: home ? { lat: home.lat, lng: home.lng } : null,
        placement_type: p.placementType,
        visit_type: meta(p).visit_type === 'ONE_TIME' ? 'ONE_TIME' : 'REGULAR',
        today: shift?.checkOutAt ? 'CHECKED_OUT' : shift?.checkInAt ? 'CHECKED_IN' : 'NOT_CHECKED_IN',
      };
    }));
    return { date: today, checked_in_at: open?.placementId ?? null, location_interval_sec: LOCATION_INTERVAL_SEC, placements: items };
  }

  async checkIn(userId: string, body: Record<string, unknown>) {
    const staff = await this.staffOf(userId);
    const today = istNow().date;
    const day = dbDate(today);
    const point = optPoint(body.latitude ?? body.lat, body.longitude ?? body.lng);
    const wanted = body.placement_id ? String(body.placement_id) : null;

    const { ok, all } = await this.checkInable(staff.id, today);
    if (!ok.length) {
      const visit = all.find((p) => meta(p).visit_type === 'ONE_TIME');
      throw new BadRequestException(
        visit
          ? `Your visit is on ${String(meta(visit).visit_date ?? visit.trialStartDate?.toISOString().slice(0, 10))} — you can check in on that day.`
          : 'No active placement — you can check in once your RM has placed you.',
      );
    }

    // Choose the house.
    let placement: Placement | undefined;
    if (wanted) {
      placement = ok.find((p) => p.id === wanted);
      if (!placement) throw new BadRequestException('You are not placed at that house today.');
    } else if (ok.length === 1) {
      placement = ok[0];
    } else if (point) {
      // Several houses: the one whose home is nearest to where the phone is.
      let best: { p: Placement; d: number } | null = null;
      for (const p of ok) {
        const h = await this.homeOf(p);
        if (!h) continue;
        const d = metersBetween(point, h);
        if (!best || d < best.d) best = { p, d };
      }
      placement = best?.p;
    }
    if (!placement) {
      throw new BadRequestException('You work at more than one house — choose where you are checking in (placement_id).');
    }

    const open = await this.openShift(staff.id, day);
    if (open && open.placementId !== placement.id) {
      const other = open.placementId ? await this.prisma.placement.findUnique({ where: { id: open.placementId }, select: { clientId: true } }) : null;
      const name = other ? (await this.clientsById([other.clientId])).get(other.clientId)?.customerName : null;
      throw new BadRequestException(`You are checked in at ${name ?? 'another house'} — check out there first.`);
    }

    const home = await this.homeOf(placement);
    const distance = point && home ? metersBetween(point, home) : null;
    const now = new Date();

    let shift: ShiftLog;
    let already = false;
    if (open) {
      // Pressed twice: nothing to change.
      shift = open;
      already = true;
    } else {
      const existing = await this.prisma.shiftLog.findFirst({ where: { staffId: staff.id, placementId: placement.id, shiftDate: day } });
      const metaPatch = { check_in_distance_m: distance } as Prisma.InputJsonObject;
      if (existing?.checkInAt) {
        // Back at the same house after checking out (e.g. after lunch): reopen the day,
        // keeping the first check-in so the hours run from it.
        shift = await this.prisma.shiftLog.update({
          where: { id: existing.id },
          data: { checkOutAt: null, checkOutLat: null, checkOutLng: null, status: 'APPROVED', metadata: { ...(meta(existing) as object), reopened_at: now.toISOString() } },
        });
      } else if (existing) {
        shift = await this.prisma.shiftLog.update({
          where: { id: existing.id },
          data: { checkInAt: now, checkInLat: point?.lat, checkInLng: point?.lng, status: 'APPROVED', metadata: { ...(meta(existing) as object), ...metaPatch } },
        });
      } else {
        shift = await this.prisma.shiftLog.create({
          data: {
            staffId: staff.id,
            placementId: placement.id,
            shiftDate: day,
            checkInAt: now,
            checkInLat: point?.lat,
            checkInLng: point?.lng,
            status: 'APPROVED',
            metadata: metaPatch,
          },
        });
      }

      // Attendance is billable the moment staff checks in — the same sync
      // reviewShift() does on APPROVED. Keyed by placement: the day belongs to
      // the client whose invoice carries it.
      await this.prisma.staffDailyAttendance
        .upsert({
          where: { staffId_placementId_attendanceDate: { staffId: staff.id, placementId: placement.id, attendanceDate: day } },
          create: { staffId: staff.id, placementId: placement.id, branchId: placement.branchId, attendanceDate: day, status: 'PRESENT', markedBy: userId },
          update: { status: 'PRESENT', branchId: placement.branchId, markedBy: userId },
        })
        .catch((e) => this.logger.warn(`attendance sync on check-in failed: ${e.message}`));

      const client = (await this.clientsById([placement.clientId])).get(placement.clientId);
      const where = howFar(distance);
      await this.notify(
        [client?.userId],
        `${firstName(staff.fullName)} checked in`,
        `Checked in at ${clock(shift.checkInAt ?? now)}${where ? ` · ${where}` : ''}`,
        'STAFF_CHECKED_IN',
        { placement_id: placement.id, staff_id: staff.id, shift_id: shift.id },
      );
      if (distance !== null && distance > FAR_METERS) {
        await this.notify(
          [placement.rmId ?? staff.assignedRmId],
          'Check-in away from home',
          `${staff.fullName} checked in ${howFar(distance)} at ${client?.customerName ?? 'the client'}.`,
          'STAFF_CHECKIN_FAR',
          { placement_id: placement.id, staff_id: staff.id, shift_id: shift.id, distance_m: distance },
        );
      }
    }

    const client = (await this.clientsById([placement.clientId])).get(placement.clientId);
    return {
      success: true,
      attendanceId: shift.id,
      status: 'CHECKED_IN',
      already_checked_in: already,
      placement_id: placement.id,
      client_name: client?.customerName ?? 'Client',
      latitude: point?.lat ?? null,
      longitude: point?.lng ?? null,
      distance_m: distance,
      at_home: distance === null ? null : distance <= FAR_METERS,
      timestamp: shift.checkInAt?.toISOString(),
      location_interval_sec: LOCATION_INTERVAL_SEC,
    };
  }

  async checkOut(userId: string, body: Record<string, unknown>) {
    const staff = await this.staffOf(userId);
    const today = istNow().date;
    const day = dbDate(today);
    const point = optPoint(body.latitude ?? body.lat, body.longitude ?? body.lng);
    const open = await this.openShift(staff.id, day, body.placement_id ? String(body.placement_id) : undefined);
    if (!open) {
      const done = await this.prisma.shiftLog.findFirst({ where: { staffId: staff.id, shiftDate: day, checkOutAt: { not: null } } });
      throw new BadRequestException(done ? 'You have already checked out today.' : 'No check-in found for today — check in before checking out');
    }
    const now = new Date();
    const placement = open.placementId ? await this.prisma.placement.findUnique({ where: { id: open.placementId } }) : null;
    const home = placement ? await this.homeOf(placement) : null;
    const distance = point && home ? metersBetween(point, home) : null;
    const shift = await this.prisma.shiftLog.update({
      where: { id: open.id },
      data: {
        checkOutAt: now,
        checkOutLat: point?.lat,
        checkOutLng: point?.lng,
        metadata: { ...(meta(open) as object), check_out_distance_m: distance, away_notified: false },
      },
    });
    const workedMs = now.getTime() - (open.checkInAt ?? now).getTime();

    // An hourly placement is billed on the hours worked, so the day carries them.
    if (placement?.placementType === 'TEMPORARY') {
      const hours = Math.round((workedMs / 3_600_000) * 10) / 10;
      await this.prisma.staffDailyAttendance
        .updateMany({ where: { staffId: staff.id, placementId: placement.id, attendanceDate: day }, data: { hoursWorked: Math.min(hours, 99.9) } })
        .catch((e) => this.logger.warn(`hours on check-out failed: ${e.message}`));
    }

    if (placement) {
      const client = (await this.clientsById([placement.clientId])).get(placement.clientId);
      await this.notify(
        [client?.userId],
        `${firstName(staff.fullName)} checked out`,
        `Checked out at ${clock(now)} · ${duration(workedMs)}`,
        'STAFF_CHECKED_OUT',
        { placement_id: placement.id, staff_id: staff.id, shift_id: shift.id },
      );
    }

    return {
      success: true,
      attendanceId: shift.id,
      status: 'CHECKED_OUT',
      placement_id: shift.placementId,
      latitude: point?.lat ?? null,
      longitude: point?.lng ?? null,
      distance_m: distance,
      worked: duration(workedMs),
      timestamp: shift.checkOutAt?.toISOString(),
    };
  }

  /**
   * Location while checked in: { points: [{ latitude, longitude, accuracy?, battery?, recorded_at? }] }
   * (or one point at the top level). Points collected offline can come in one batch.
   */
  async addLocation(userId: string, body: Record<string, unknown>) {
    const staff = await this.staffOf(userId);
    const day = dbDate(istNow().date);
    const open = await this.openShift(staff.id, day);
    if (!open || !open.placementId) {
      throw new BadRequestException('You are not checked in — location is shared only during a shift.');
    }
    const raw = Array.isArray(body.points) ? (body.points as Record<string, unknown>[]) : [body];
    if (!raw.length) throw new BadRequestException('Send at least one point.');
    if (raw.length > MAX_POINTS) throw new BadRequestException(`Send at most ${MAX_POINTS} points at a time.`);

    const now = Date.now();
    const from = (open.checkInAt ?? new Date(now)).getTime() - 60_000;
    const parsed = raw.map((r, i) => {
      const p = optPoint(r.latitude ?? r.lat, r.longitude ?? r.lng, `points[${i}]`);
      if (!p) throw new BadRequestException(`points[${i}]: latitude and longitude are required.`);
      const at = r.recorded_at ? new Date(String(r.recorded_at)) : new Date(now);
      if (Number.isNaN(at.getTime())) throw new BadRequestException(`points[${i}].recorded_at must be an ISO date-time.`);
      const acc = num(r.accuracy ?? r.accuracy_m);
      const bat = num(r.battery ?? r.battery_pct);
      return { ...p, at, accuracy: acc === null ? null : Math.round(acc), battery: bat === null ? null : Math.max(0, Math.min(100, Math.round(bat))) };
    });

    // Only points inside the shift, and at most one per MIN_GAP_MS.
    const last = await this.prisma.staffLocationPing.findFirst({ where: { shiftLogId: open.id }, orderBy: { recordedAt: 'desc' } });
    let prev = last?.recordedAt.getTime() ?? -Infinity;
    const keep: typeof parsed = [];
    for (const p of parsed.sort((a, b) => a.at.getTime() - b.at.getTime())) {
      const t = p.at.getTime();
      if (t < from || t > now + 2 * 60_000) continue;
      if (t - prev < MIN_GAP_MS) continue;
      keep.push(p);
      prev = t;
    }
    if (keep.length) {
      await this.prisma.staffLocationPing.createMany({
        data: keep.map((p) => ({
          staffId: staff.id,
          placementId: open.placementId!,
          shiftLogId: open.id,
          lat: p.lat,
          lng: p.lng,
          accuracyM: p.accuracy,
          batteryPct: p.battery,
          recordedAt: p.at,
        })),
      });
      await this.checkAway(open, staff);
    }
    return { accepted: keep.length, dropped: parsed.length - keep.length, next_in_sec: LOCATION_INTERVAL_SEC };
  }

  /** Two points in a row away from home → tell the client and the RM, once until they are back. */
  private async checkAway(shift: ShiftLog, staff: { id: string; fullName: string; assignedRmId: string | null }) {
    const placement = await this.prisma.placement.findUnique({ where: { id: shift.placementId! } });
    if (!placement) return;
    const home = await this.homeOf(placement);
    if (!home) return;
    const lastTwo = await this.prisma.staffLocationPing.findMany({ where: { shiftLogId: shift.id }, orderBy: { recordedAt: 'desc' }, take: 2 });
    const dist = lastTwo.map((p) => metersBetween({ lat: Number(p.lat), lng: Number(p.lng) }, home));
    const fresh = await this.prisma.shiftLog.findUnique({ where: { id: shift.id } });
    const m = meta(fresh ?? shift);
    const away = dist.length === 2 && dist.every((d) => d > FAR_METERS);
    if (away && m.away_notified !== true) {
      await this.prisma.shiftLog.update({ where: { id: shift.id }, data: { metadata: { ...(m as object), away_notified: true } as Prisma.InputJsonObject } });
      const client = (await this.clientsById([placement.clientId])).get(placement.clientId);
      const where = howFar(dist[0]);
      await this.notify(
        [client?.userId, placement.rmId ?? staff.assignedRmId],
        `${firstName(staff.fullName)} is away from home`,
        `${staff.fullName} is ${where} during the shift (${clock(lastTwo[0].recordedAt)}).`,
        'STAFF_AWAY_FROM_HOME',
        { placement_id: placement.id, staff_id: staff.id, shift_id: shift.id, distance_m: dist[0] },
      );
    } else if (!away && dist.length && dist[0] <= FAR_METERS && m.away_notified === true) {
      await this.prisma.shiftLog.update({ where: { id: shift.id }, data: { metadata: { ...(m as object), away_notified: false } as Prisma.InputJsonObject } });
    }
  }

  // ── client app ────────────────────────────────────────────────────────────

  /** The finance customer behind a client login. Office roles get null (they are not a household). */
  private async customerOf(user: AuthUser) {
    const c = await this.prisma.financeCustomer.findFirst({ where: { userId: user.id }, select: { id: true, customerName: true } });
    if (!c && user.role === 'CLIENT') throw new ForbiddenException('No client account is linked to this login.');
    return c;
  }

  /** A placement of this staff member at this client, the active one first. Office roles: any placement. */
  private async placementAtClient(user: AuthUser, staffId: string, activeOnly: boolean) {
    const customer = await this.customerOf(user);
    const p = await this.prisma.placement.findFirst({
      where: { staffId, ...(customer ? { clientId: customer.id } : {}), ...(activeOnly ? { status: { in: [...ACTIVE] } } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    if (!p) throw new ForbiddenException('This staff member does not work at your home.');
    return p;
  }

  private async shiftView(p: Placement, day: Date) {
    const shift = await this.prisma.shiftLog.findFirst({ where: { staffId: p.staffId, placementId: p.id, shiftDate: day } });
    const home = await this.homeOf(p);
    const open = !!(shift?.checkInAt && !shift.checkOutAt);
    const last = open ? await this.prisma.staffLocationPing.findFirst({ where: { shiftLogId: shift!.id }, orderBy: { recordedAt: 'desc' } }) : null;
    const pt = last
      ? { lat: Number(last.lat), lng: Number(last.lng), at: last.recordedAt, accuracy_m: last.accuracyM }
      : open && shift?.checkInLat != null && shift.checkInLng != null
        ? { lat: Number(shift.checkInLat), lng: Number(shift.checkInLng), at: shift.checkInAt!, accuracy_m: null }
        : null;
    const d = pt && home ? metersBetween(pt, home) : null;
    return {
      shift,
      home,
      status: shift?.checkOutAt ? 'CHECKED_OUT' : shift?.checkInAt ? 'PRESENT' : 'NOT_CHECKED_IN',
      last: pt
        ? {
            at: pt.at.toISOString(),
            lat: pt.lat,
            lng: pt.lng,
            accuracy_m: pt.accuracy_m,
            distance_m: d,
            at_home: d === null ? null : d <= FAR_METERS,
            label: howFar(d),
            stale: Date.now() - pt.at.getTime() > STALE_MS,
          }
        : null,
    };
  }

  /** Every staff member working at this home today (one entry per active placement). */
  async todayForClient(user: AuthUser) {
    const customer = await this.customerOf(user);
    if (!customer) return { staffCode: null, todayStatus: 'NO_ACTIVE_PLACEMENT', staff: [] };
    const day = dbDate(istNow().date);
    const placements = await this.prisma.placement.findMany({
      where: { clientId: customer.id, status: { in: [...ACTIVE] } },
      orderBy: { createdAt: 'desc' },
    });
    const staffRows = await this.prisma.staffApplicant.findMany({
      where: { id: { in: placements.map((p) => p.staffId) } },
      select: { id: true, staffCode: true, fullName: true, series: true },
    });
    const byId = new Map(staffRows.map((s) => [s.id, s]));
    const staff = await Promise.all(placements.map(async (p) => {
      const s = byId.get(p.staffId);
      const v = await this.shiftView(p, day);
      return {
        staff_id: p.staffId,
        placement_id: p.id,
        staff_code: s?.staffCode ?? null,
        name: s?.fullName ?? null,
        series: s?.series ?? null,
        series_label: s ? SERIES_LABEL[s.series] ?? s.series : null,
        status: v.status,
        check_in: v.shift?.checkInAt?.toISOString() ?? null,
        check_out: v.shift?.checkOutAt?.toISOString() ?? null,
        gps_verified: !!(v.shift?.checkInLat && v.shift?.checkInLng),
        check_in_distance_m: (meta(v.shift ?? { metadata: {} }).check_in_distance_m as number | null | undefined) ?? null,
        last_location: v.last,
      };
    }));
    // The first staff member's fields at the top level, as before, so older app builds keep working.
    const first = staff[0];
    return {
      staffCode: first?.staff_code ?? null,
      staffName: first?.name ?? null,
      todayStatus: first ? (first.status === 'NOT_CHECKED_IN' ? 'NOT_CHECKED_IN' : first.status) : 'NO_ACTIVE_PLACEMENT',
      checkInTime: first?.check_in ?? null,
      checkOutTime: first?.check_out ?? null,
      gpsVerified: first?.gps_verified ?? false,
      date: istNow().date,
      staff,
    };
  }

  /** Days worked at this home only — never the staff member's days at other houses. */
  async historyForClient(user: AuthUser, q: { staff_id?: string; from?: string; to?: string }) {
    const customer = await this.customerOf(user);
    if (!customer) return { totalPresent: 0, totalAbsent: 0, history: [] };
    const today = istNow().date;
    const to = q.to ? parseDate(q.to, 'to') : today;
    const from = q.from ? parseDate(q.from, 'from') : addDays(to, -29);
    if (from > to) throw new BadRequestException('from is after to.');
    if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw new BadRequestException('Ask for at most 3 months at a time.');
    const placements = await this.prisma.placement.findMany({
      where: { clientId: customer.id, ...(q.staff_id ? { staffId: q.staff_id } : {}) },
      select: { id: true, staffId: true, placementType: true },
    });
    const shifts = placements.length
      ? await this.prisma.shiftLog.findMany({
          where: { placementId: { in: placements.map((p) => p.id) }, shiftDate: { gte: dbDate(from), lte: dbDate(to) } },
          orderBy: [{ shiftDate: 'desc' }, { checkInAt: 'desc' }],
          include: { staff: { select: { fullName: true, staffCode: true } } },
        })
      : [];
    return {
      from,
      to,
      totalPresent: shifts.filter((s) => s.checkInAt && s.status !== 'REJECTED').length,
      totalAbsent: shifts.filter((s) => !s.checkInAt || s.status === 'REJECTED').length,
      history: shifts.map((s) => ({
        date: s.shiftDate.toISOString().slice(0, 10),
        staff_id: s.staffId,
        staff_name: s.staff.fullName,
        placement_id: s.placementId,
        status: s.checkInAt && s.status !== 'REJECTED' ? 'PRESENT' : 'ABSENT',
        checkIn: s.checkInAt?.toISOString() ?? null,
        checkOut: s.checkOutAt?.toISOString() ?? null,
        worked: s.checkInAt && s.checkOutAt ? duration(s.checkOutAt.getTime() - s.checkInAt.getTime()) : null,
      })),
    };
  }

  /** Where the staff member is now — only while they are checked in at this home. */
  async locationForClient(user: AuthUser, staffId: string) {
    const p = await this.placementAtClient(user, staffId, true);
    const day = dbDate(istNow().date);
    const v = await this.shiftView(p, day);
    const open = v.status === 'PRESENT';
    const trail = open
      ? await this.prisma.staffLocationPing.findMany({ where: { shiftLogId: v.shift!.id }, orderBy: { recordedAt: 'asc' }, take: 300 })
      : [];
    const checkInPoint =
      v.shift?.checkInLat != null && v.shift.checkInLng != null
        ? { lat: Number(v.shift.checkInLat), lng: Number(v.shift.checkInLng) }
        : null;
    const ciDist = checkInPoint && v.home ? metersBetween(checkInPoint, v.home) : null;
    return {
      staff_id: staffId,
      placement_id: p.id,
      status: v.status,
      check_in: v.shift?.checkInAt
        ? { at: v.shift.checkInAt.toISOString(), ...(checkInPoint ?? { lat: null, lng: null }), distance_m: ciDist, label: howFar(ciDist) }
        : null,
      check_out: v.shift?.checkOutAt ? { at: v.shift.checkOutAt.toISOString() } : null,
      // Never shown outside the shift.
      last: open ? v.last : null,
      home: v.home ? { lat: v.home.lat, lng: v.home.lng } : null,
      trail: trail.map((t) => ({ at: t.recordedAt.toISOString(), lat: Number(t.lat), lng: Number(t.lng) })),
      far_meters: FAR_METERS,
      next_refresh_sec: open ? 60 : null,
    };
  }

  /** The latest photo document of the staff member, if any. */
  private async photoDoc(staffId: string) {
    const emp = await this.prisma.employee.findFirst({ where: { staffApplicantId: staffId, deletedAt: null }, select: { id: true } });
    if (!emp) return null;
    return this.prisma.employeeDocument.findFirst({
      where: { employeeId: emp.id, type: { contains: 'photo', mode: 'insensitive' }, NOT: { status: { in: ['REJECTED', 'Rejected', 'rejected'] } } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
  }

  /**
   * Who is working in this home. Only staff placed here (now or before). Never:
   * Aadhaar, home address, bank, documents, salary.
   */
  async profileForClient(user: AuthUser, staffId: string) {
    const p = await this.placementAtClient(user, staffId, false);
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId }, include: { verificationTracks: true } });
    if (!staff) throw new NotFoundException('Staff record not found');
    const m = meta(staff);
    const track = (t: string) => staff.verificationTracks.find((v) => v.trackType === t)?.status === 'CLEAR';
    const rmId = p.rmId ?? staff.assignedRmId;
    const rm = rmId ? await this.prisma.user.findUnique({ where: { id: rmId }, select: { fullName: true, phone: true } }).catch(() => null) : null;
    const photo = await this.photoDoc(staffId);
    const required = REQUIRED_TRACKS[staff.series] ?? [];
    const pvOk = staff.series === 'MAID' ? staff.pvStatus !== 'ADVERSE' : staff.pvStatus === 'CLEAR';
    return {
      staff_id: staff.id,
      staff_code: staff.staffCode,
      full_name: staff.fullName,
      first_name: firstName(staff.fullName),
      photo_url: photo ? `/client/staff/${staff.id}/photo` : null,
      phone: staff.mobile,
      age: ageFrom(staff.dateOfBirth),
      gender: (m.gender as string | undefined) ?? null,
      series: staff.series,
      series_label: SERIES_LABEL[staff.series] ?? staff.series,
      language_tier: staff.languageTier,
      language_tier_label: staff.languageTier ? LANGUAGE_TIER_LABEL[staff.languageTier] : null,
      city: (m.city as string | undefined) ?? null,
      hometown: (m.hometown as string | undefined) ?? null,
      experience_years: num(m.experience_years),
      emergency_contact_name: staff.emergencyContactName ?? null,
      verification: {
        is_verified: required.every((t) => track(t)) && pvOk,
        police_verification: staff.pvStatus,
        id_verified: track('AADHAAR_EKYC'),
        health_screening: required.includes('HEALTH_SCREENING') ? track('HEALTH_SCREENING') : null,
        video_certified: !!staff.videoCertId,
        trained: TRAINED_STAGES.includes(staff.pipelineStage),
      },
      placement: {
        placement_id: p.id,
        status: p.status,
        status_label: PLACEMENT_STATUS_LABEL[p.status] ?? p.status,
        placement_type: p.placementType,
        visit_type: meta(p).visit_type === 'ONE_TIME' ? 'ONE_TIME' : 'REGULAR',
        start_date: p.trialStartDate?.toISOString().slice(0, 10) ?? p.createdAt.toISOString().slice(0, 10),
        shift_hours: p.shiftHours != null ? Number(p.shiftHours) : null,
      },
      rm: rm ? { name: rm.fullName, phone: rm.phone } : null,
      // Legacy fields, so older app builds keep working.
      staffId: staff.id,
      staffCode: staff.staffCode,
      fullName: staff.fullName,
      isVerified: required.every((t) => track(t)) && pvOk,
      pvStatus: staff.pvStatus,
      videoCertAvailable: !!staff.videoCertId,
    };
  }

  async photoForClient(user: AuthUser, staffId: string) {
    await this.placementAtClient(user, staffId, false);
    const doc = await this.photoDoc(staffId);
    if (!doc) throw new NotFoundException('No photo on file for this staff member.');
    return this.documents.getFileDetails(doc.id);
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  /** Location points are kept 30 days. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOldPoints() {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000);
    const r = await this.prisma.staffLocationPing.deleteMany({ where: { recordedAt: { lt: cutoff } } });
    if (r.count) this.logger.log(`purged ${r.count} location points older than ${KEEP_DAYS} days`);
    return r.count;
  }
}

/**
 * Verification tracks each series needs, besides police verification. Keyed by
 * the long StaffSeries values (not UC/SC short codes) — keying by short codes once
 * made every lookup miss and showed unverified staff as verified.
 */
const REQUIRED_TRACKS: Record<string, string[]> = {
  DRIVER: ['AADHAAR_EKYC', 'SARATHI_API', 'ECHALLAN_API', 'HEALTH_SCREENING'],
  SKILLED_CARE: ['AADHAAR_EKYC', 'HEALTH_SCREENING'],
  UNSKILLED_CARE: ['AADHAAR_EKYC'],
  MAID: ['AADHAAR_EKYC'],
  COOK: ['AADHAAR_EKYC', 'HEALTH_SCREENING'],
};

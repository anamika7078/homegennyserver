import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Placement, Prisma, StaffSeries } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';

/**
 * Who may see or change what on a placement, for everything in daily-care:
 *   CLIENT — the client of the placement (reads always, writes while it is active)
 *   STAFF  — the staff member of the placement, only while it is active
 *   RM/BM/ADMIN — the placement's RM, the branch BM, any Admin
 * Medical details live here, so every endpoint goes through one of these.
 */

export const ACTIVE_PLACEMENT = ['TRIAL', 'CONFIRMED'];
export const CARE_SERIES: StaffSeries[] = [StaffSeries.UNSKILLED_CARE, StaffSeries.SKILLED_CARE];

export interface PlacementCtx {
  placement: Placement;
  staff: { id: string; fullName: string; series: StaffSeries; userId: string | null; assignedRmId: string | null };
  client: { id: string; customerName: string; userId: string | null };
  role: 'CLIENT' | 'STAFF' | 'RM' | 'BM' | 'ADMIN';
  active: boolean;
}

/** IST — every date and HH:MM in daily care is the household's local time. */
export function istNow(): { date: string; hhmm: string; minutes: number } {
  const d = new Date(Date.now() + 330 * 60_000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** YYYY-MM-DD → UTC-midnight Date, so a @db.Date column stores the day meant (this server runs IST). */
export function dbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
export function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function parseDate(v: unknown, field = 'date'): string {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new BadRequestException(`${field} must be YYYY-MM-DD.`);
  }
  return s;
}
/** Staff may write today's or yesterday's record — not older, not the future. */
export function assertLoggableDate(date: string) {
  const today = istNow().date;
  if (date !== today && date !== addDays(today, -1)) {
    throw new BadRequestException(`Only today (${today}) or yesterday can be filled in — ${date} is closed.`);
  }
}
/**
 * JSON with object keys sorted. Postgres jsonb stores keys in its own order, so
 * comparing a stored value with a freshly built one needs this, not JSON.stringify.
 */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
export function parseTimes(v: unknown, field: string): string[] {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(',');
  const times = arr.map((x) => String(x).trim()).filter(Boolean);
  if (!times.length) throw new BadRequestException(`${field} needs at least one time (HH:MM).`);
  for (const t of times) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new BadRequestException(`${field}: "${t}" is not a time — use HH:MM (24h).`);
  }
  return [...new Set(times)].sort();
}

@Injectable()
export class CareAccessService {
  private readonly logger = new Logger(CareAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async load(placementId: string) {
    const placement = await this.prisma.placement.findUnique({ where: { id: placementId } });
    if (!placement) throw new NotFoundException('Placement not found.');
    const [staff, client] = await Promise.all([
      this.prisma.staffApplicant.findUnique({
        where: { id: placement.staffId },
        select: { id: true, fullName: true, series: true, userId: true, assignedRmId: true },
      }),
      this.prisma.financeCustomer.findUnique({
        where: { id: placement.clientId },
        select: { id: true, customerName: true, userId: true },
      }),
    ]);
    if (!staff || !client) throw new NotFoundException('Placement not found.');
    return { placement, staff, client, active: ACTIVE_PLACEMENT.includes(placement.status) };
  }

  /** Any logged-in role, dispatched on role. `write` additionally needs an active placement. */
  async resolve(user: AuthUser, placementId: string, opts: { write?: boolean } = {}): Promise<PlacementCtx> {
    const base = await this.load(placementId);
    let role: PlacementCtx['role'];
    switch (user.role) {
      case 'CLIENT':
        if (base.client.userId !== user.id) throw new NotFoundException('Placement not found.');
        role = 'CLIENT';
        break;
      case 'STAFF':
        // A staff member sees a household only while working there.
        if (base.staff.userId !== user.id || !base.active) throw new NotFoundException('Placement not found.');
        role = 'STAFF';
        break;
      case 'RM':
        if (base.placement.rmId !== user.id && base.staff.assignedRmId !== user.id) {
          throw new ForbiddenException('This placement belongs to another RM.');
        }
        role = 'RM';
        break;
      case 'BM':
        if (user.branchId && base.placement.branchId !== user.branchId) throw new ForbiddenException('Not your branch.');
        role = 'BM';
        break;
      case 'ADMIN':
        role = 'ADMIN';
        break;
      default:
        throw new ForbiddenException('Not allowed.');
    }
    if (opts.write && !base.active) {
      throw new BadRequestException(`This placement is ${base.placement.status} — it can no longer be changed.`);
    }
    return { ...base, role };
  }

  assertCare(ctx: PlacementCtx) {
    if (!CARE_SERIES.includes(ctx.staff.series)) {
      throw new BadRequestException('Care plans are for caretaker (UC/SC) placements.');
    }
  }
  assertCook(ctx: PlacementCtx) {
    if (ctx.staff.series !== StaffSeries.COOK) {
      throw new BadRequestException('Menus and meal logs are for cook (CK) placements.');
    }
  }

  /** The staff record behind a STAFF login. */
  async staffForUser(userId: string) {
    const staff = await this.prisma.staffApplicant.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true, fullName: true, series: true },
    });
    if (!staff) throw new BadRequestException('No staff record is linked to this login.');
    return staff;
  }

  /** The staff member's active placements, with the client's name. */
  async activePlacementsForStaff(staffId: string) {
    const ps = await this.prisma.placement.findMany({
      where: { staffId, status: { in: ACTIVE_PLACEMENT as never } },
      orderBy: { createdAt: 'asc' },
    });
    const clients = await this.prisma.financeCustomer.findMany({
      where: { id: { in: ps.map((p) => p.clientId) } },
      select: { id: true, customerName: true, address: true },
    });
    const byId = new Map(clients.map((c) => [c.id, c]));
    return ps.map((p) => ({ placement: p, client: byId.get(p.clientId) ?? null }));
  }

  // ── notifications (in-app) ────────────────────────────────────────────────

  async notify(userIds: (string | null | undefined)[], title: string, body: string, template: string, payload: Record<string, unknown>) {
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

  /** The people who answer for a placement: its RM, and the branch BMs when it is serious. */
  async rmOf(ctx: Pick<PlacementCtx, 'placement' | 'staff'>): Promise<string | null> {
    return ctx.placement.rmId ?? ctx.staff.assignedRmId ?? null;
  }
  async bmsOf(branchId: string | null): Promise<string[]> {
    const bms = branchId
      ? await this.prisma.user.findMany({ where: { role: 'BM', isActive: true, branchId }, select: { id: true } })
      : [];
    if (bms.length) return bms.map((b) => b.id);
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
    return admins.map((a) => a.id);
  }
}

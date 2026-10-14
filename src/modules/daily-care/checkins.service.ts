import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { istNow, parseDate } from './care-access.service';

/**
 * Where staff checked in and out, for the RM's map —
 * docs/MENU_TRACKING_REQUEST_CHANGES_PLAN.md §3. No live tracking: these are
 * the GPS points the staff app already sends with check-in/check-out
 * (shift_logs). Each one is measured against the client's home; more than
 * FAR_METERS away is flagged.
 */

export const FAR_METERS = 300;

/** Great-circle distance in metres. */
export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function latLng(body: Record<string, unknown>) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new BadRequestException('lat and lng are required and must be a real location.');
  }
  return { lat, lng };
}

interface Row {
  shift_id: string;
  shift_date: Date;
  status: string;
  check_in_at: Date | null;
  check_out_at: Date | null;
  check_in_lat: string | null;
  check_in_lng: string | null;
  check_out_lat: string | null;
  check_out_lng: string | null;
  staff_id: string;
  staff_name: string;
  staff_code: string;
  series: string;
  placement_id: string | null;
  branch_name: string | null;
  client_id: string | null;
  client_name: string | null;
  client_address: string | null;
  home_lat: string | null;
  home_lng: string | null;
  req_lat: string | null;
  req_lng: string | null;
}

@Injectable()
export class CheckinsService {
  constructor(private readonly prisma: PrismaService) {}

  /** RM: their placements; BM: the branch; Admin: all. One day (IST), default today. */
  async list(user: AuthUser, q: { date?: string; branch_id?: string }) {
    const date = q.date ? parseDate(q.date) : istNow().date;
    const scope =
      user.role === 'RM'
        ? Prisma.sql`AND (p.rm_id = ${user.id}::uuid OR sa.assigned_rm_id = ${user.id}::uuid)`
        : user.role === 'BM' && user.branchId
          ? Prisma.sql`AND COALESCE(p.branch_id, sa.branch_id) = ${user.branchId}::uuid`
          : q.branch_id
            ? Prisma.sql`AND COALESCE(p.branch_id, sa.branch_id) = ${q.branch_id}::uuid`
            : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT sl.id AS shift_id, sl.shift_date, sl.status::text AS status,
             sl.check_in_at, sl.check_out_at,
             sl.check_in_lat::text, sl.check_in_lng::text, sl.check_out_lat::text, sl.check_out_lng::text,
             sa.id AS staff_id, sa.full_name AS staff_name, sa.staff_code, sa.series::text AS series,
             p.id AS placement_id, b.name AS branch_name,
             fc.id AS client_id, fc.customer_name AS client_name, fc.address AS client_address,
             fc.lat::text AS home_lat, fc.lng::text AS home_lng,
             sr.lat::text AS req_lat, sr.lng::text AS req_lng
        FROM shift_logs sl
        JOIN staff_applicants sa ON sa.id = sl.staff_id
        LEFT JOIN placements p ON p.id = sl.placement_id
        LEFT JOIN branches b ON b.id = COALESCE(p.branch_id, sa.branch_id)
        LEFT JOIN finance_customers fc ON fc.id = p.client_id
        LEFT JOIN staff_requests sr ON sr.id::text = p.metadata->>'staff_request_id'
       WHERE sl.shift_date = ${date}::date ${scope}
       ORDER BY sl.check_in_at NULLS LAST
       LIMIT 1000`;

    const num = (v: string | null) => (v === null ? null : Number(v));
    const items = rows.map((r) => {
      // The client's saved home, else the pin from the staff request this placement filled.
      const home =
        r.home_lat !== null && r.home_lng !== null
          ? { lat: num(r.home_lat)!, lng: num(r.home_lng)!, source: 'CLIENT' as const }
          : r.req_lat !== null && r.req_lng !== null
            ? { lat: num(r.req_lat)!, lng: num(r.req_lng)!, source: 'STAFF_REQUEST' as const }
            : null;
      const point = (lat: string | null, lng: string | null, at: Date | null) => {
        if (lat === null || lng === null) return at ? { at, lat: null, lng: null, distance_m: null, far: null } : null;
        const p = { lat: num(lat)!, lng: num(lng)! };
        const d = home ? metersBetween(p, home) : null;
        return { at, ...p, distance_m: d, far: d === null ? null : d > FAR_METERS };
      };
      return {
        shift_id: r.shift_id,
        status: r.status,
        staff: { id: r.staff_id, name: r.staff_name, code: r.staff_code, series: r.series },
        client: r.client_id ? { id: r.client_id, name: r.client_name, address: r.client_address } : null,
        placement_id: r.placement_id,
        branch: r.branch_name,
        home,
        check_in: point(r.check_in_lat, r.check_in_lng, r.check_in_at),
        check_out: point(r.check_out_lat, r.check_out_lng, r.check_out_at),
      };
    });
    const far = (i: (typeof items)[number]) => !!(i.check_in?.far || i.check_out?.far);
    return {
      date,
      far_meters: FAR_METERS,
      summary: {
        total: items.length,
        with_gps: items.filter((i) => i.check_in?.lat !== null && i.check_in?.lat !== undefined).length,
        far: items.filter(far).length,
        no_home: items.filter((i) => i.client && !i.home).length,
      },
      items,
    };
  }

  /** The client sets their home from the app (map pin). */
  async setOwnHome(userId: string, body: Record<string, unknown>) {
    const c = await this.prisma.financeCustomer.findFirst({ where: { userId }, select: { id: true } });
    if (!c) throw new BadRequestException('No client account is linked to this login.');
    const { lat, lng } = latLng(body);
    await this.prisma.financeCustomer.update({ where: { id: c.id }, data: { lat, lng } });
    return { client_id: c.id, lat, lng };
  }

  /** The RM sets a client's home — e.g. "use this check-in as the home" on the map. */
  async setClientHome(user: AuthUser, clientId: string, body: Record<string, unknown>) {
    const c = await this.prisma.financeCustomer.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!c) throw new NotFoundException('Client not found.');
    if (user.role === 'RM' || user.role === 'BM') {
      const mine = await this.prisma.placement.findFirst({
        where: { clientId, ...(user.role === 'RM' ? { rmId: user.id } : { branchId: user.branchId ?? undefined }) },
        select: { id: true },
      });
      if (!mine) throw new ForbiddenException('This client has no placement of yours.');
    }
    const { lat, lng } = latLng(body);
    await this.prisma.financeCustomer.update({ where: { id: clientId }, data: { lat, lng } });
    return { client_id: clientId, lat, lng };
  }
}

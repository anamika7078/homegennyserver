import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditAction, Prisma, StaffRequest, StaffSeries } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { assertSeriesActive } from '../../common/config/active-series';
import { mapSeriesFromShort, mapSeriesToShort } from '../../common/mappers/staff.mapper';
import { MEDICAL_DUTY_CODES } from '../series/series.constants';

/**
 * Staff requests — Phase B of docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md.
 *
 *   NEW (no RM yet) → ASSIGNED → SHORTLISTED → CLIENT_SELECTED → FULFILLED
 *                                     ↑ client rejects all ┘
 *   any open status → CANCELLED
 *
 * A candidate goes PROPOSED → CLIENT_SELECTED → PLACED, or CLIENT_REJECTED /
 * WITHDRAWN. The placement itself is still made by POST /placements; this
 * module only records which request it fulfilled (see linkPlacement()).
 */

export const OPEN_STATUSES = ['NEW', 'ASSIGNED', 'SHORTLISTED', 'CLIENT_SELECTED'] as const;
const LIVE_CANDIDATE = ['PROPOSED', 'CLIENT_SELECTED'];
/** A request with no shortlist this long after it was raised is flagged, and its BM told once. */
export const SLA_HOURS = 24;

const MOBILITY = ['WALKING', 'ASSISTED', 'BEDRIDDEN'];
const DIET_TYPES = ['VEG', 'EGG', 'NON_VEG', 'JAIN', 'VEGAN'];
const MEALS = ['BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER'];
const GENDERS = ['ANY', 'FEMALE', 'MALE'];

type Db = Prisma.TransactionClient | PrismaService;

function str(v: unknown): string | undefined {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s ? s : undefined;
}
function strList(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
}
function num(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestException(`${field} must be a number.`);
  return n;
}
/** YYYY-MM-DD → a UTC-midnight Date, so @db.Date stores the day that was meant (this server runs IST). */
function dateOnly(v: unknown, field: string): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequestException(`${field} must be YYYY-MM-DD.`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a real date.`);
  return d;
}
function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

@Injectable()
export class StaffRequestsService {
  private readonly logger = new Logger(StaffRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Validation ─────────────────────────────────────────────────────────────

  /** The fields a request is made of, checked. Shared by the client app and the RM form. */
  private parseRequestBody(body: Record<string, unknown>) {
    const rawSeries = str(body.series);
    if (!rawSeries) throw new BadRequestException('series is required (UC, SC or CK).');
    const series = mapSeriesFromShort(rawSeries);
    assertSeriesActive(series);

    const placementType = (str(body.placement_type) ?? 'PERMANENT').toUpperCase();
    if (!['PERMANENT', 'TEMPORARY'].includes(placementType)) {
      throw new BadRequestException('placement_type must be PERMANENT or TEMPORARY.');
    }
    const shiftHours = num(body.shift_hours, 'shift_hours') ?? 8;
    if (shiftHours <= 0 || shiftHours > 24) throw new BadRequestException('shift_hours must be between 1 and 24.');

    const startDate = dateOnly(body.start_date, 'start_date');
    if (startDate && startDate.toISOString().slice(0, 10) < todayIst()) {
      throw new BadRequestException('start_date cannot be in the past.');
    }

    // Start time is optional; when the start is today it can't already have passed.
    const startTime = str(body.start_time);
    if (startTime !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new BadRequestException('start_time must be HH:MM (24-hour).');
      if (!startDate) throw new BadRequestException('Give start_date along with start_time.');
      const nowIst = new Date(Date.now() + 330 * 60_000).toISOString();
      if (startDate.toISOString().slice(0, 10) === todayIst() && startTime < nowIst.slice(11, 16)) {
        throw new BadRequestException('start_time has already passed today.');
      }
    }

    const genderPref = (str(body.gender_pref) ?? 'ANY').toUpperCase();
    if (!GENDERS.includes(genderPref)) throw new BadRequestException(`gender_pref must be one of ${GENDERS.join(', ')}.`);

    // Address is required on every request — the client confirms where the staff
    // will work instead of it being assumed from the account. Budget is no longer
    // asked for (budget_min/max are ignored if sent).
    const address = str(body.address);
    if (!address || address.length < 5) throw new BadRequestException('address is required — where will the staff work?');
    const lat = num(body.lat, 'lat');
    const lng = num(body.lng, 'lng');
    if ((lat === undefined) !== (lng === undefined)) throw new BadRequestException('Send lat and lng together.');
    if (lat !== undefined && (lat < -90 || lat > 90 || lng! < -180 || lng! > 180)) {
      throw new BadRequestException('lat/lng are not a real location.');
    }

    const headcount = num(body.headcount, 'headcount') ?? 1;
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 20) {
      throw new BadRequestException('headcount must be a whole number from 1 to 20.');
    }

    return {
      series,
      placementType,
      shiftHours,
      startDate,
      startTime,
      address,
      lat,
      lng,
      language: str(body.language),
      genderPref,
      headcount,
      requirements: this.parseRequirements(series, (body.requirements ?? {}) as Record<string, unknown>),
      notes: str(body.notes),
    };
  }

  /** What the series needs to know. Care: the patient. Cook: the kitchen. */
  private parseRequirements(series: StaffSeries, r: Record<string, unknown>): Record<string, unknown> {
    if (series === StaffSeries.COOK) {
      const dietType = (str(r.diet_type) ?? '').toUpperCase();
      if (!DIET_TYPES.includes(dietType)) {
        throw new BadRequestException(`requirements.diet_type is required — one of ${DIET_TYPES.join(', ')}.`);
      }
      const familySize = num(r.family_size, 'requirements.family_size');
      if (!familySize || familySize < 1 || !Number.isInteger(familySize)) {
        throw new BadRequestException('requirements.family_size is required (how many people the cook feeds).');
      }
      const meals = strList(r.meals_per_day);
      if (!meals.length || meals.some((m) => !MEALS.includes(m))) {
        throw new BadRequestException(`requirements.meals_per_day is required — any of ${MEALS.join(', ')}.`);
      }
      return {
        diet_type: dietType,
        family_size: familySize,
        meals_per_day: meals,
        cuisines: strList(r.cuisines),
        health_conditions: strList(r.health_conditions),
      };
    }

    // UNSKILLED_CARE / SKILLED_CARE — about the person being cared for.
    const age = num(r.patient_age, 'requirements.patient_age');
    if (!age || age < 0 || age > 120) throw new BadRequestException('requirements.patient_age is required.');
    const mobility = (str(r.mobility) ?? '').toUpperCase();
    if (!MOBILITY.includes(mobility)) {
      throw new BadRequestException(`requirements.mobility is required — one of ${MOBILITY.join(', ')}.`);
    }
    const medicalNeeds = strList(r.medical_needs);
    // A UC may not do medical duties (series.service assertNoMedicalDuty) —
    // better to say so now than to shortlist someone who can't do the job.
    const medical = medicalNeeds.filter((n) => MEDICAL_DUTY_CODES.includes(n));
    if (series === StaffSeries.UNSKILLED_CARE && medical.length) {
      throw new BadRequestException(
        `An Unskilled Caretaker cannot do medical duties (${medical.join(', ')}). Ask for a Skilled Caretaker (SC) instead.`,
      );
    }
    const gender = str(r.patient_gender)?.toUpperCase();
    return {
      patient_age: age,
      ...(gender ? { patient_gender: gender } : {}),
      mobility,
      conditions: strList(r.conditions),
      medical_needs: medicalNeeds,
      night_care: r.night_care === true || r.night_care === 'true',
    };
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /** The client's branch: where they already have staff, else a branch in their city. */
  private async resolveBranch(clientId: string | null, city?: string | null): Promise<string | null> {
    if (clientId) {
      const p = await this.prisma.placement.findFirst({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        select: { branchId: true },
      });
      if (p?.branchId) return p.branchId;
    }
    if (city) {
      const b = await this.prisma.branch.findFirst({
        where: { isActive: true, city: { equals: city, mode: 'insensitive' } },
        select: { id: true },
      });
      if (b) return b.id;
    }
    return null;
  }

  /**
   * The RM who already looks after this client, else the branch RM with the
   * fewest open requests. Null when the branch has no RM — the request then
   * waits as NEW for the BM to assign.
   */
  private async pickRm(clientId: string | null, branchId: string | null): Promise<string | null> {
    if (clientId) {
      const p = await this.prisma.placement.findFirst({
        where: { clientId, rmId: { not: null }, status: { in: ['TRIAL', 'CONFIRMED'] } },
        orderBy: { createdAt: 'desc' },
        select: { rmId: true },
      });
      if (p?.rmId) {
        const rm = await this.prisma.user.findFirst({ where: { id: p.rmId, role: 'RM', isActive: true }, select: { id: true } });
        if (rm) return rm.id;
      }
    }
    if (!branchId) return null;
    const rms = await this.prisma.user.findMany({
      where: { role: 'RM', isActive: true, branchId },
      select: { id: true },
    });
    if (!rms.length) return null;
    const loads = await this.prisma.staffRequest.groupBy({
      by: ['rmId'],
      where: { rmId: { in: rms.map((r) => r.id) }, status: { in: [...OPEN_STATUSES] } },
      _count: true,
    });
    const load = new Map(loads.map((l) => [l.rmId, l._count]));
    return rms.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0].id;
  }

  private async nextRequestNo(db: Db): Promise<string> {
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT nextval('staff_request_no_seq') AS n`;
    return `SR-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
  }

  // ── Notifications (in-app; read by /client/notifications and /notifications/in-app) ──

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

/** The branch's BMs — or the Admins, when there is no branch or it has no BM. */
  private async bmsFor(branchId: string | null): Promise<string[]> {
    const bms = branchId
      ? await this.prisma.user.findMany({ where: { role: 'BM', isActive: true, branchId }, select: { id: true } })
      : [];
    if (bms.length) return bms.map((r) => r.id);
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
    return admins.map((r) => r.id);
  }

  private async clientUserId(clientId: string | null): Promise<string | null> {
    if (!clientId) return null;
    const c = await this.prisma.financeCustomer.findUnique({ where: { id: clientId }, select: { userId: true } });
    return c?.userId ?? null;
  }

  private async log(actorId: string | undefined, req: { id: string; requestNo: string }, action: string, extra: Record<string, unknown> = {}) {
    await this.audit
      .log({
        actorId,
        action: AuditAction.APPROVAL,
        entityType: 'staff_request',
        entityId: req.id,
        metadata: { request_no: req.requestNo, action, ...extra },
      })
      .catch(() => undefined);
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async resolveCustomer(userId: string) {
    const c = await this.prisma.financeCustomer.findFirst({ where: { userId } });
    if (!c) throw new BadRequestException('No client account is linked to this login.');
    return c;
  }

  /** From the client app — the client is whoever is logged in. */
  async createFromClient(userId: string, body: Record<string, unknown>) {
    const customer = await this.resolveCustomer(userId);
    const fields = this.parseRequestBody(body);
    const branchId = await this.resolveBranch(customer.id, customer.city);
    const created = await this.insert(
      {
        ...fields,
        clientId: customer.id,
        branchId,
        source: 'CLIENT_APP',
      },
      userId,
    );
    // The first pin a client drops becomes their home location (used by the
    // RM's check-in map); a home they or the RM already set is left alone.
    if (fields.lat !== undefined && fields.lng !== undefined) {
      await this.prisma.financeCustomer.updateMany({
        where: { id: customer.id, lat: null },
        data: { lat: fields.lat, lng: fields.lng },
      });
    }
    // The client gets the client view — never the RM's (staff phones, branch, SLA).
    return this.getForClient(userId, created.id);
  }

  /** From the RM web — for an existing client, or a lead with no account yet. */
  async createFromRm(user: AuthUser, body: Record<string, unknown>) {
    const fields = this.parseRequestBody(body);
    const clientId = str(body.client_id) ?? null;
    let customer: { id: string; address: string; city: string | null } | null = null;
    if (clientId) {
      customer = await this.prisma.financeCustomer.findUnique({ where: { id: clientId }, select: { id: true, address: true, city: true } });
      if (!customer) throw new BadRequestException('client_id is not a known client.');
    }
    const leadName = str(body.lead_name);
    const leadPhone = str(body.lead_phone);
    if (!customer && (!leadName || !leadPhone)) {
      throw new BadRequestException('Give client_id, or lead_name and lead_phone for someone without an account yet.');
    }
    if (leadPhone && !/^\+?\d{10,15}$/.test(leadPhone)) throw new BadRequestException('lead_phone must be 10–15 digits.');
    const leadCity = str(body.lead_city);

    const branchId =
      (user.role === 'ADMIN' ? str(body.branch_id) : undefined) ??
      user.branchId ??
      (await this.resolveBranch(customer?.id ?? null, customer?.city ?? leadCity));

    return this.insert(
      {
        ...fields,
        clientId: customer?.id ?? null,
        leadName: customer ? undefined : leadName,
        leadPhone: customer ? undefined : leadPhone,
        leadCity: customer ? undefined : leadCity,
        branchId,
        source: 'RM_WEB',
        // An RM who raises it owns it; a BM/Admin's goes through the same routing as a client's.
        rmId: user.role === 'RM' ? user.id : undefined,
      },
      user.id,
    );
  }

  private async insert(
    data: ReturnType<StaffRequestsService['parseRequestBody']> & {
      clientId: string | null;
      leadName?: string;
      leadPhone?: string;
      leadCity?: string;
      branchId: string | null;
      source: string;
      rmId?: string;
      replacementRequestId?: string;
    },
    actorId: string,
  ) {
    const rmId = data.rmId ?? (await this.pickRm(data.clientId, data.branchId));
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const requestNo = await this.nextRequestNo(tx);
      return tx.staffRequest.create({
        data: {
          requestNo,
          clientId: data.clientId,
          leadName: data.leadName,
          leadPhone: data.leadPhone,
          leadCity: data.leadCity,
          branchId: data.branchId,
          rmId,
          source: data.source,
          replacementRequestId: data.replacementRequestId,
          series: data.series,
          placementType: data.placementType,
          shiftHours: data.shiftHours,
          startDate: data.startDate,
          startTime: data.startTime,
          address: data.address,
          lat: data.lat,
          lng: data.lng,
          language: data.language,
          genderPref: data.genderPref,
          headcount: data.headcount,
          requirements: data.requirements as Prisma.InputJsonValue,
          notes: data.notes,
          status: rmId ? 'ASSIGNED' : 'NEW',
          assignedAt: rmId ? now : null,
          createdBy: actorId,
        },
      });
    });

    await this.log(actorId, row, 'created', { source: data.source, rm_id: rmId });
    const what = `${mapSeriesToShort(row.series)} ×${row.headcount}`;
    if (rmId && rmId !== actorId) {
      await this.notify([rmId], 'New staff request', `${row.requestNo}: ${what} — please shortlist staff.`, 'STAFF_REQUEST_ASSIGNED', { request_id: row.id });
    } else if (!rmId) {
      await this.notify(await this.bmsFor(row.branchId), 'Staff request needs an RM', `${row.requestNo}: ${what} has no RM — assign one.`, 'STAFF_REQUEST_UNASSIGNED', { request_id: row.id });
    }
    return this.getForStaffUser(row.id);
  }

  /** A client's replacement request, turned into a request for new staff. */
  async convertReplacement(user: AuthUser, replacementId: string, body: Record<string, unknown>) {
    const [rr] = await this.prisma.$queryRaw<
      { id: string; client_id: string; placement_id: string | null; staff_id: string | null; branch_id: string | null; rm_id: string | null; status: string; reason: string }[]
    >`SELECT id, client_id, placement_id, staff_id, branch_id, rm_id, status, reason FROM replacement_requests WHERE id = ${replacementId}::uuid`;
    if (!rr) throw new NotFoundException('Replacement request not found.');
    if (user.role === 'RM' && rr.rm_id && rr.rm_id !== user.id) throw new ForbiddenException('This replacement belongs to another RM.');
    if (user.role === 'BM' && user.branchId && rr.branch_id && rr.branch_id !== user.branchId) throw new ForbiddenException('Not your branch.');
    if (!['UNDER_RM_REVIEW', 'APPROVED'].includes(rr.status)) {
      throw new BadRequestException(`This replacement request is already ${rr.status}.`);
    }
    const existing = await this.prisma.staffRequest.findFirst({ where: { replacementRequestId: rr.id, status: { not: 'CANCELLED' } } });
    if (existing) throw new BadRequestException(`Already converted — ${existing.requestNo}.`);

    // Default the ask to "the same kind of person, on the same terms".
    const [staff, placement] = await Promise.all([
      rr.staff_id ? this.prisma.staffApplicant.findUnique({ where: { id: rr.staff_id }, select: { series: true } }) : null,
      rr.placement_id ? this.prisma.placement.findUnique({ where: { id: rr.placement_id }, select: { placementType: true, shiftHours: true } }) : null,
    ]);
    const home = await this.prisma.financeCustomer.findUnique({ where: { id: rr.client_id }, select: { address: true } });
    const merged: Record<string, unknown> = {
      series: staff?.series,
      // Same house as the staff being replaced, unless the RM says otherwise.
      address: home?.address,
      placement_type: placement?.placementType,
      shift_hours: placement?.shiftHours?.toString(),
      notes: `Replacement: ${rr.reason}`,
      ...body,
    };
    const fields = this.parseRequestBody(merged);

    const created = await this.insert(
      {
        ...fields,
        clientId: rr.client_id,
        branchId: rr.branch_id ?? user.branchId ?? null,
        source: 'REPLACEMENT',
        replacementRequestId: rr.id,
        rmId: rr.rm_id ?? (user.role === 'RM' ? user.id : undefined),
      },
      user.id,
    );
    await this.prisma.$executeRaw`
      UPDATE replacement_requests
         SET status = 'APPROVED', resolution = ${`Converted to staff request ${created.request_no}`}, updated_at = NOW()
       WHERE id = ${rr.id}::uuid`;
    return created;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /** RM: own requests plus the unassigned ones in their branch. BM: the branch. Admin: all. */
  private scopeWhere(user: AuthUser): Prisma.StaffRequestWhereInput {
    if (user.role === 'ADMIN') return {};
    if (user.role === 'BM') return user.branchId ? { branchId: user.branchId } : {};
    return {
      OR: [
        { rmId: user.id },
        ...(user.branchId ? [{ rmId: null, branchId: user.branchId }] : []),
      ],
    };
  }

  private async loadForStaffUser(user: AuthUser, id: string) {
    const row = await this.prisma.staffRequest.findFirst({ where: { id, ...this.scopeWhere(user) } });
    if (!row) throw new NotFoundException('Staff request not found.');
    return row;
  }

  async list(user: AuthUser, q: { status?: string; series?: string; branch_id?: string; open?: string }) {
    const where: Prisma.StaffRequestWhereInput = { ...this.scopeWhere(user) };
    if (q.status) where.status = { in: q.status.split(',').map((s) => s.trim().toUpperCase()) };
    else if (q.open === 'true') where.status = { in: [...OPEN_STATUSES] };
    if (q.series) where.series = mapSeriesFromShort(q.series);
    if (q.branch_id && user.role === 'ADMIN') where.branchId = q.branch_id;

    const rows = await this.prisma.staffRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        client: { select: { customerName: true } },
        rm: { select: { fullName: true } },
        branch: { select: { name: true } },
        candidates: { select: { status: true } },
      },
    });
    const items = rows.map((r) => ({
      ...this.mapRow(r),
      client_name: r.client?.customerName ?? r.leadName,
      rm_name: r.rm?.fullName ?? null,
      branch_name: r.branch?.name ?? null,
      candidate_counts: r.candidates.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
    }));
    const counts = items.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    return { items, total: items.length, counts, sla_breached: items.filter((i) => i.sla_breached).length };
  }

  async getForStaffUser(id: string, user?: AuthUser) {
    const row = user
      ? await this.loadForStaffUser(user, id)
      : await this.prisma.staffRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Staff request not found.');
    const [client, rm, branch, candidates] = await Promise.all([
      row.clientId ? this.prisma.financeCustomer.findUnique({ where: { id: row.clientId }, select: { id: true, customerName: true, unitCode: true, city: true, userId: true } }) : null,
      row.rmId ? this.prisma.user.findUnique({ where: { id: row.rmId }, select: { id: true, fullName: true, phone: true } }) : null,
      row.branchId ? this.prisma.branch.findUnique({ where: { id: row.branchId }, select: { id: true, name: true, city: true } }) : null,
      this.prisma.staffRequestCandidate.findMany({
        where: { requestId: id },
        orderBy: { createdAt: 'asc' },
        include: { staff: { select: { id: true, staffCode: true, fullName: true, series: true, pipelineStage: true, mobile: true, languageTier: true } } },
      }),
    ]);
    return {
      ...this.mapRow(row),
      client: client ? { id: client.id, name: client.customerName, unit_code: client.unitCode, city: client.city, has_login: !!client.userId } : null,
      rm: rm ? { id: rm.id, name: rm.fullName, phone: rm.phone } : null,
      branch,
      candidates: candidates.map((c) => ({
        id: c.id,
        status: c.status,
        rm_note: c.rmNote,
        client_note: c.clientNote,
        placement_id: c.placementId,
        added_at: c.createdAt,
        staff: {
          id: c.staff.id,
          staff_code: c.staff.staffCode,
          full_name: c.staff.fullName,
          series: mapSeriesToShort(c.staff.series),
          series_db: c.staff.series,
          pipeline_stage: c.staff.pipelineStage,
          mobile: c.staff.mobile,
          language_tier: c.staff.languageTier,
        },
      })),
    };
  }

  /** Client app: their own requests, and a privacy-safe card for each shortlisted staff member. */
  async listForClient(userId: string) {
    const customer = await this.prisma.financeCustomer.findFirst({ where: { userId }, select: { id: true } });
    if (!customer) return { items: [], total: 0 };
    const rows = await this.prisma.staffRequest.findMany({
      where: { clientId: customer.id },
      orderBy: { createdAt: 'desc' },
      include: { candidates: { where: { status: { not: 'WITHDRAWN' } }, select: { status: true } } },
    });
    const items = rows.map((r) => ({
      ...this.mapRow(r, true),
      shortlisted: r.candidates.filter((c) => c.status === 'PROPOSED').length,
      selected: r.candidates.filter((c) => c.status === 'CLIENT_SELECTED' || c.status === 'PLACED').length,
    }));
    return { items, total: items.length };
  }

  async getForClient(userId: string, id: string) {
    const customer = await this.resolveCustomer(userId);
    const row = await this.prisma.staffRequest.findFirst({ where: { id, clientId: customer.id } });
    if (!row) throw new NotFoundException('Staff request not found.');
    const [rm, candidates] = await Promise.all([
      row.rmId ? this.prisma.user.findUnique({ where: { id: row.rmId }, select: { fullName: true, phone: true } }) : null,
      this.prisma.staffRequestCandidate.findMany({
        where: { requestId: id, status: { not: 'WITHDRAWN' } },
        orderBy: { createdAt: 'asc' },
        include: { staff: { select: { id: true, fullName: true, series: true, languageTier: true, metadata: true, verificationTracks: { select: { trackType: true, status: true } }, pvStatus: true } } },
      }),
    ]);
    return {
      ...this.mapRow(row, true),
      rm: rm ? { name: rm.fullName, phone: rm.phone } : null,
      candidates: candidates.map((c) => {
        const meta = (c.staff.metadata ?? {}) as Record<string, unknown>;
        const clear = new Set(c.staff.verificationTracks.filter((t) => t.status === 'CLEAR').map((t) => t.trackType));
        return {
          candidate_id: c.id,
          status: c.status,
          rm_note: c.rmNote,
          client_note: c.clientNote,
          // Only what a client needs to choose. No phone, Aadhaar, address or surname.
          staff: {
            id: c.staff.id,
            first_name: c.staff.fullName.split(' ')[0],
            series: mapSeriesToShort(c.staff.series),
            series_db: c.staff.series,
            language_tier: c.staff.languageTier,
            gender: meta.gender ?? null,
            experience_years: meta.experience_years ?? null,
            aadhaar_verified: clear.has('AADHAAR_EKYC'),
            police_verified: c.staff.pvStatus === 'CLEAR',
          },
        };
      }),
    };
  }

  private mapRow(r: StaffRequest, forClient = false) {
    const ageH = (Date.now() - r.createdAt.getTime()) / 3_600_000;
    return {
      id: r.id,
      request_no: r.requestNo,
      status: r.status,
      source: r.source,
      series: mapSeriesToShort(r.series),
      series_db: r.series,
      placement_type: r.placementType,
      shift_hours: Number(r.shiftHours),
      start_date: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
      start_time: r.startTime,
      address: r.address,
      lat: r.lat !== null ? Number(r.lat) : null,
      lng: r.lng !== null ? Number(r.lng) : null,
      language: r.language,
      gender_pref: r.genderPref,
      headcount: r.headcount,
      requirements: r.requirements,
      notes: r.notes,
      cancel_reason: r.cancelReason,
      created_at: r.createdAt,
      assigned_at: r.assignedAt,
      shortlisted_at: r.shortlistedAt,
      selected_at: r.selectedAt,
      fulfilled_at: r.fulfilledAt,
      cancelled_at: r.cancelledAt,
      ...(forClient
        ? {}
        : {
            client_id: r.clientId,
            lead: r.clientId ? null : { name: r.leadName, phone: r.leadPhone, city: r.leadCity },
            branch_id: r.branchId,
            rm_id: r.rmId,
            replacement_request_id: r.replacementRequestId,
            age_hours: Math.round(ageH),
            sla_breached: ['NEW', 'ASSIGNED'].includes(r.status) && ageH > SLA_HOURS,
          }),
    };
  }

  // ── Candidates ─────────────────────────────────────────────────────────────

  /**
   * Who could fill this request, best first. Same series, not restricted, no
   * open HOLD, and free under the placement rules (a PERMANENT request needs
   * someone with no active placement; a TEMPORARY one, someone with no active
   * PERMANENT). Only S5_DEPLOY staff can be placed; S4 staff are listed too,
   * marked ready=false, since they are days away.
   */
  async candidates(user: AuthUser, id: string) {
    const req = await this.loadForStaffUser(user, id);
    const rows = await this.prisma.$queryRaw<
      {
        id: string; staff_code: string; full_name: string; series: string; pipeline_stage: string;
        branch_id: string | null; language_tier: string | null; gender: string | null; branch_name: string | null;
        active_permanent: number; active_any: number; open_holds: number; already: string | null;
      }[]
    >`
      SELECT sa.id, sa.staff_code, sa.full_name, sa.series::text, sa.pipeline_stage::text,
             sa.branch_id, sa.language_tier::text, sa.metadata->>'gender' AS gender, b.name AS branch_name,
             (SELECT count(*)::int FROM placements p WHERE p.staff_id = sa.id AND p.status IN ('TRIAL','CONFIRMED') AND p.placement_type = 'PERMANENT') AS active_permanent,
             (SELECT count(*)::int FROM placements p WHERE p.staff_id = sa.id AND p.status IN ('TRIAL','CONFIRMED')) AS active_any,
             (SELECT count(*)::int FROM stage_holds h WHERE h.staff_id = sa.id AND h.released_at IS NULL AND h.kind = 'HOLD') AS open_holds,
             (SELECT c.status FROM staff_request_candidates c WHERE c.request_id = ${req.id}::uuid AND c.staff_id = sa.id) AS already
        FROM staff_applicants sa
        LEFT JOIN branches b ON b.id = sa.branch_id
       WHERE sa.deleted_at IS NULL
         AND sa.restricted_list = false
         AND sa.series = ${req.series}::staff_applicants_series_enum
         AND sa.pipeline_stage IN ('S4_AGREEMENTS', 'S5_DEPLOY')
       LIMIT 300`;

    const wantGender = req.genderPref === 'ANY' ? null : req.genderPref;
    const items = rows
      .filter((s) => s.open_holds === 0)
      .filter((s) => (req.placementType === 'PERMANENT' ? s.active_any === 0 : s.active_permanent === 0))
      .map((s) => {
        const reasons: string[] = [];
        let score = 0;
        const ready = s.pipeline_stage === 'S5_DEPLOY';
        if (ready) { score += 3; reasons.push('Ready to deploy (S5)'); } else reasons.push('In S4 — agreements pending');
        if (req.branchId && s.branch_id === req.branchId) { score += 3; reasons.push('Same branch'); }
        if (wantGender && s.gender?.toUpperCase() === wantGender) { score += 2; reasons.push(`${wantGender === 'FEMALE' ? 'Female' : 'Male'}, as asked`); }
        if (wantGender && s.gender && s.gender.toUpperCase() !== wantGender) { score -= 5; reasons.push('Gender differs from the ask'); }
        if (req.placementType === 'TEMPORARY' && s.active_any > 0) reasons.push(`Already on ${s.active_any} hourly placement(s)`);
        return {
          staff: {
            id: s.id, staff_code: s.staff_code, full_name: s.full_name,
            series: mapSeriesToShort(s.series as StaffSeries), series_db: s.series,
            pipeline_stage: s.pipeline_stage, branch_name: s.branch_name, language_tier: s.language_tier, gender: s.gender,
          },
          ready,
          score,
          reasons,
          on_this_request: s.already,
        };
      })
      .sort((a, b) => b.score - a.score);
    return { request_id: req.id, items, total: items.length };
  }

  private async assertEligible(req: StaffRequest, staffId: string) {
    const { items } = await this.candidates({ id: '', role: 'ADMIN' }, req.id);
    const hit = items.find((c) => c.staff.id === staffId);
    if (!hit) {
      throw new BadRequestException(
        `Staff ${staffId} can't be put forward for this request — wrong series, restricted, on hold, not yet at S4/S5, or already placed elsewhere.`,
      );
    }
  }

  private assertOpen(req: StaffRequest) {
    if (!OPEN_STATUSES.includes(req.status as (typeof OPEN_STATUSES)[number])) {
      throw new BadRequestException(`This request is ${req.status} — nothing more can change on it.`);
    }
  }

  async shortlist(user: AuthUser, id: string, body: { staff_ids?: unknown; rm_note?: unknown }) {
    const req = await this.loadForStaffUser(user, id);
    this.assertOpen(req);
    const ids = [...new Set((Array.isArray(body.staff_ids) ? body.staff_ids : []).map(String).filter(Boolean))];
    if (!ids.length) throw new BadRequestException('staff_ids is required — at least one staff member.');
    for (const sid of ids) await this.assertEligible(req, sid);
    const note = str(body.rm_note) ?? null;

    await this.prisma.$transaction(async (tx) => {
      for (const sid of ids) {
        await tx.staffRequestCandidate.upsert({
          where: { requestId_staffId: { requestId: id, staffId: sid } },
          // Putting someone forward again (after a withdraw or a client "no") re-proposes them.
          update: { status: 'PROPOSED', rmNote: note, updatedAt: new Date() },
          create: { requestId: id, staffId: sid, status: 'PROPOSED', rmNote: note, addedBy: user.id },
        });
      }
      await tx.staffRequest.update({
        where: { id },
        data: {
          // Whoever shortlists an unassigned request takes it on.
          rmId: req.rmId ?? (user.role === 'RM' ? user.id : req.rmId),
          assignedAt: req.assignedAt ?? new Date(),
          status: req.status === 'CLIENT_SELECTED' ? 'CLIENT_SELECTED' : 'SHORTLISTED',
          shortlistedAt: req.shortlistedAt ?? new Date(),
          updatedAt: new Date(),
        },
      });
    });
    await this.log(user.id, req, 'shortlisted', { staff_ids: ids });
    await this.notify([await this.clientUserId(req.clientId)], 'Staff shortlisted for you', `${req.requestNo}: ${ids.length} staff ready for you to choose.`, 'STAFF_REQUEST_SHORTLISTED', { request_id: id });
    return this.getForStaffUser(id);
  }

  async withdraw(user: AuthUser, id: string, staffId: string) {
    const req = await this.loadForStaffUser(user, id);
    this.assertOpen(req);
    const c = await this.prisma.staffRequestCandidate.findUnique({ where: { requestId_staffId: { requestId: id, staffId } } });
    if (!c || !LIVE_CANDIDATE.includes(c.status)) throw new BadRequestException('That staff member is not on this shortlist.');
    await this.prisma.staffRequestCandidate.update({ where: { id: c.id }, data: { status: 'WITHDRAWN', updatedAt: new Date() } });
    await this.recomputeStatus(id);
    await this.log(user.id, req, 'withdrawn', { staff_id: staffId });
    return this.getForStaffUser(id);
  }

  /** Puts the request's status back in line with its candidates after one changes. */
  private async recomputeStatus(id: string) {
    const req = await this.prisma.staffRequest.findUniqueOrThrow({ where: { id } });
    if (!OPEN_STATUSES.includes(req.status as (typeof OPEN_STATUSES)[number])) return;
    const cs = await this.prisma.staffRequestCandidate.findMany({ where: { requestId: id }, select: { status: true } });
    const placed = cs.filter((c) => c.status === 'PLACED').length;
    const selected = cs.filter((c) => c.status === 'CLIENT_SELECTED').length;
    const proposed = cs.filter((c) => c.status === 'PROPOSED').length;
    let status: string;
    if (placed >= req.headcount) status = 'FULFILLED';
    else if (selected + placed > 0) status = 'CLIENT_SELECTED';
    else if (proposed > 0) status = 'SHORTLISTED';
    else status = req.rmId ? 'ASSIGNED' : 'NEW';
    if (status !== req.status) {
      await this.prisma.staffRequest.update({
        where: { id },
        data: { status, updatedAt: new Date(), ...(status === 'FULFILLED' ? { fulfilledAt: new Date() } : {}) },
      });
    }
  }

  /** The client (or the RM on their behalf) picks a shortlisted staff member. */
  private async select(req: StaffRequest, staffId: string, note: string | undefined, actorId: string, byClient: boolean) {
    this.assertOpen(req);
    const c = await this.prisma.staffRequestCandidate.findUnique({ where: { requestId_staffId: { requestId: req.id, staffId } } });
    if (!c || c.status !== 'PROPOSED') throw new BadRequestException('Only a shortlisted (PROPOSED) staff member can be chosen.');
    const taken = await this.prisma.staffRequestCandidate.count({ where: { requestId: req.id, status: { in: ['CLIENT_SELECTED', 'PLACED'] } } });
    if (taken >= req.headcount) {
      throw new BadRequestException(`This request is for ${req.headcount} staff and ${taken} already chosen.`);
    }
    await this.prisma.staffRequestCandidate.update({
      where: { id: c.id },
      data: { status: 'CLIENT_SELECTED', clientNote: note ?? c.clientNote, updatedAt: new Date() },
    });
    await this.prisma.staffRequest.update({ where: { id: req.id }, data: { selectedAt: req.selectedAt ?? new Date(), updatedAt: new Date() } });
    await this.recomputeStatus(req.id);
    await this.log(actorId, req, byClient ? 'client_selected' : 'rm_selected_for_client', { staff_id: staffId });
    if (byClient) {
      await this.notify([req.rmId], 'Client chose staff', `${req.requestNo}: the client picked a staff member — set up the trial placement.`, 'STAFF_REQUEST_SELECTED', { request_id: req.id, staff_id: staffId });
    }
  }

  async selectByClient(userId: string, id: string, body: { staff_id?: unknown; note?: unknown }) {
    const customer = await this.resolveCustomer(userId);
    const req = await this.prisma.staffRequest.findFirst({ where: { id, clientId: customer.id } });
    if (!req) throw new NotFoundException('Staff request not found.');
    const staffId = str(body.staff_id);
    if (!staffId) throw new BadRequestException('staff_id is required.');
    await this.select(req, staffId, str(body.note), userId, true);
    return this.getForClient(userId, id);
  }

  async selectByRm(user: AuthUser, id: string, body: { staff_id?: unknown; note?: unknown }) {
    const req = await this.loadForStaffUser(user, id);
    const staffId = str(body.staff_id);
    if (!staffId) throw new BadRequestException('staff_id is required.');
    await this.select(req, staffId, str(body.note), user.id, false);
    return this.getForStaffUser(id);
  }

  /** The client says none of the shortlist will do — back to the RM for a new one. */
  async rejectShortlist(userId: string, id: string, body: { reason?: unknown }) {
    const customer = await this.resolveCustomer(userId);
    const req = await this.prisma.staffRequest.findFirst({ where: { id, clientId: customer.id } });
    if (!req) throw new NotFoundException('Staff request not found.');
    this.assertOpen(req);
    const reason = str(body.reason);
    if (!reason) throw new BadRequestException('Tell us why — the RM uses it to find better matches.');
    const n = await this.prisma.staffRequestCandidate.updateMany({
      where: { requestId: id, status: 'PROPOSED' },
      data: { status: 'CLIENT_REJECTED', clientNote: reason, updatedAt: new Date() },
    });
    if (!n.count) throw new BadRequestException('There is no shortlist waiting for you on this request.');
    await this.recomputeStatus(id);
    await this.log(userId, req, 'client_rejected_shortlist', { reason });
    await this.notify([req.rmId], 'Client turned down the shortlist', `${req.requestNo}: "${reason}" — please shortlist again.`, 'STAFF_REQUEST_REJECTED', { request_id: id });
    return this.getForClient(userId, id);
  }

  async cancelByClient(userId: string, id: string, body: { reason?: unknown }) {
    const customer = await this.resolveCustomer(userId);
    const req = await this.prisma.staffRequest.findFirst({ where: { id, clientId: customer.id } });
    if (!req) throw new NotFoundException('Staff request not found.');
    await this.cancel(req, body, userId);
    await this.notify([req.rmId], 'Client cancelled a request', `${req.requestNo} was cancelled by the client.`, 'STAFF_REQUEST_CANCELLED', { request_id: id });
    return this.getForClient(userId, id);
  }

  async cancelByRm(user: AuthUser, id: string, body: { reason?: unknown }) {
    const req = await this.loadForStaffUser(user, id);
    await this.cancel(req, body, user.id);
    await this.notify([await this.clientUserId(req.clientId)], 'Staff request closed', `${req.requestNo} was closed by HomeGenny: ${str(body.reason)}`, 'STAFF_REQUEST_CANCELLED', { request_id: id });
    return this.getForStaffUser(id);
  }

  private async cancel(req: StaffRequest, body: { reason?: unknown }, actorId: string) {
    this.assertOpen(req);
    const reason = str(body.reason);
    if (!reason) throw new BadRequestException('reason is required to cancel a request.');
    await this.prisma.$transaction([
      this.prisma.staffRequestCandidate.updateMany({
        where: { requestId: req.id, status: { in: LIVE_CANDIDATE } },
        data: { status: 'WITHDRAWN', updatedAt: new Date() },
      }),
      this.prisma.staffRequest.update({
        where: { id: req.id },
        data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date(), updatedAt: new Date() },
      }),
    ]);
    await this.log(actorId, req, 'cancelled', { reason });
  }

  /** BM/Admin hands the request to an RM (or takes it off one). */
  async assign(user: AuthUser, id: string, body: { rm_id?: unknown }) {
    if (user.role === 'RM') throw new ForbiddenException('Only a BM or Admin can reassign a request.');
    const req = await this.loadForStaffUser(user, id);
    this.assertOpen(req);
    const rmId = str(body.rm_id);
    if (!rmId) throw new BadRequestException('rm_id is required.');
    const rm = await this.prisma.user.findFirst({ where: { id: rmId, role: 'RM', isActive: true }, select: { id: true, branchId: true } });
    if (!rm) throw new BadRequestException('rm_id is not an active RM.');
    if (user.role === 'BM' && user.branchId && rm.branchId !== user.branchId) throw new BadRequestException('That RM is not in your branch.');
    await this.prisma.staffRequest.update({
      where: { id },
      data: { rmId, assignedAt: new Date(), status: req.status === 'NEW' ? 'ASSIGNED' : req.status, updatedAt: new Date() },
    });
    await this.log(user.id, req, 'assigned', { rm_id: rmId });
    await this.notify([rmId], 'Staff request assigned to you', `${req.requestNo} is yours now — please shortlist staff.`, 'STAFF_REQUEST_ASSIGNED', { request_id: id });
    return this.getForStaffUser(id);
  }

  /** A lead became a client — attach the account so a placement can be made. */
  async attachClient(user: AuthUser, id: string, body: { client_id?: unknown }) {
    const req = await this.loadForStaffUser(user, id);
    this.assertOpen(req);
    if (req.clientId) throw new BadRequestException('This request already has a client.');
    const clientId = str(body.client_id);
    if (!clientId) throw new BadRequestException('client_id is required.');
    const c = await this.prisma.financeCustomer.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!c) throw new BadRequestException('client_id is not a known client.');
    await this.prisma.staffRequest.update({ where: { id }, data: { clientId, updatedAt: new Date() } });
    await this.log(user.id, req, 'client_attached', { client_id: clientId });
    return this.getForStaffUser(id);
  }

  // ── Placement link ─────────────────────────────────────────────────────────

  /**
   * Checks, before POST /placements writes anything, that this placement may
   * fulfil the request: still open, has a client, same client, same series,
   * and the staff member was chosen (or the RM is placing someone they
   * shortlisted). Returns the request so the caller can default from it.
   */
  async assertPlacementFits(requestId: string, staffId: string, clientId: string) {
    const req = await this.prisma.staffRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new BadRequestException('staff_request_id is not a known request.');
    this.assertOpen(req);
    if (!req.clientId) {
      throw new BadRequestException(`${req.requestNo} is a lead with no client account yet — attach the client before placing staff.`);
    }
    if (req.clientId !== clientId) throw new BadRequestException(`${req.requestNo} belongs to a different client.`);
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: staffId }, select: { series: true } });
    if (staff && staff.series !== req.series) {
      throw new BadRequestException(`${req.requestNo} asks for ${mapSeriesToShort(req.series)}, this staff member is ${mapSeriesToShort(staff.series)}.`);
    }
    const c = await this.prisma.staffRequestCandidate.findUnique({ where: { requestId_staffId: { requestId, staffId } } });
    if (!c || !LIVE_CANDIDATE.includes(c.status)) {
      throw new BadRequestException(`Shortlist this staff member on ${req.requestNo} first — only someone the client could see can fill it.`);
    }
    return req;
  }

  /** After the placement row exists: mark the candidate PLACED and move the request on. */
  async recordPlacement(requestId: string, staffId: string, placementId: string, actorId?: string) {
    const req = await this.prisma.staffRequest.findUniqueOrThrow({ where: { id: requestId } });
    await this.prisma.staffRequestCandidate.upsert({
      where: { requestId_staffId: { requestId, staffId } },
      update: { status: 'PLACED', placementId, updatedAt: new Date() },
      create: { requestId, staffId, status: 'PLACED', placementId, addedBy: actorId },
    });
    await this.recomputeStatus(requestId);
    await this.log(actorId, req, 'placed', { staff_id: staffId, placement_id: placementId });
    const after = await this.prisma.staffRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (after.status === 'FULFILLED') {
      await this.notify([await this.clientUserId(req.clientId)], 'Your staff is on the way', `${req.requestNo} is fulfilled — your trial starts as planned.`, 'STAFF_REQUEST_FULFILLED', { request_id: requestId, placement_id: placementId });
    }
  }

  /** For a placement made without the request (the old direct flow): link it afterwards. */
  async linkPlacement(user: AuthUser, id: string, body: { placement_id?: unknown }) {
    const req = await this.loadForStaffUser(user, id);
    this.assertOpen(req);
    const placementId = str(body.placement_id);
    if (!placementId) throw new BadRequestException('placement_id is required.');
    const p = await this.prisma.placement.findUnique({ where: { id: placementId }, select: { id: true, staffId: true, clientId: true, status: true, metadata: true } });
    if (!p) throw new BadRequestException('placement_id is not a known placement.');
    if (!['TRIAL', 'CONFIRMED'].includes(p.status)) throw new BadRequestException(`That placement is ${p.status}, not active.`);
    if (!req.clientId || req.clientId !== p.clientId) throw new BadRequestException('That placement is for a different client.');
    const staff = await this.prisma.staffApplicant.findUnique({ where: { id: p.staffId }, select: { series: true } });
    if (staff?.series !== req.series) throw new BadRequestException(`${req.requestNo} asks for ${mapSeriesToShort(req.series)}; that placement's staff is not.`);
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    if (meta.staff_request_id && meta.staff_request_id !== id) throw new BadRequestException('That placement already fills another request.');
    await this.prisma.placement.update({ where: { id: p.id }, data: { metadata: { ...meta, staff_request_id: id } as Prisma.InputJsonValue } });
    await this.recordPlacement(id, p.staffId, p.id, user.id);
    return this.getForStaffUser(id);
  }

  // ── SLA ────────────────────────────────────────────────────────────────────

  /** Once an hour: tell the BM about requests nobody has shortlisted for within SLA_HOURS. Once per request. */
  @Cron(CronExpression.EVERY_HOUR)
  async alertSlaBreaches() {
    const cutoff = new Date(Date.now() - SLA_HOURS * 3_600_000);
    const late = (
      await this.prisma.staffRequest.findMany({
        where: { status: { in: ['NEW', 'ASSIGNED'] }, createdAt: { lt: cutoff } },
        take: 200,
      })
    ).filter((r) => !((r.metadata ?? {}) as Record<string, unknown>).sla_alerted_at);
    for (const r of late) {
      await this.notify(
        await this.bmsFor(r.branchId),
        'Staff request waiting over 24h',
        `${r.requestNo} (${mapSeriesToShort(r.series)}) has no shortlist after ${SLA_HOURS} hours.`,
        'STAFF_REQUEST_SLA',
        { request_id: r.id },
      );
      await this.prisma.staffRequest.update({
        where: { id: r.id },
        data: { metadata: { ...((r.metadata ?? {}) as object), sla_alerted_at: new Date().toISOString() } },
      });
    }
    return late.length;
  }
}

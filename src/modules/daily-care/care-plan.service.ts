import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CarePlan, CareTask, Prisma, StaffSeries } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import {
  ACTIVE_PLACEMENT,
  CareAccessService,
  CARE_SERIES,
  PlacementCtx,
  addDays,
  assertLoggableDate,
  dateStr,
  dbDate,
  hhmmToMinutes,
  istNow,
  parseDate,
  parseTimes,
  stableJson,
} from './care-access.service';
import { CareFilesService } from './care-files.service';

/**
 * Phase C — the client's care plan for a caretaker, and the caretaker's day.
 *
 * The plan is versioned: every edit is a new ACTIVE row, the old one turns
 * SUPERSEDED, and `changes` says what moved (the staff app highlights it).
 * Each day's checklist (care_tasks) is generated from the active plan — for
 * today only, on first read or by the hourly sweep — so a plan written today
 * never produces a backlog of "missed" doses for days it didn't exist.
 *
 * A dose not ticked an hour after its time is MISSED, and the client and RM
 * are told. A vital outside its range raises an escalation at once.
 */

const ROUTES = ['ORAL', 'INJECTION', 'DROPS', 'INHALER', 'TOPICAL', 'OTHER'];
const FOOD = ['BEFORE', 'AFTER', 'WITH', 'ANY'];
const ACTIVITY_TYPES = ['EXERCISE', 'PHYSIO', 'WALK', 'BATH', 'POSITION_CHANGE', 'OTHER'];
/** How long after its time a dose may still be ticked before it counts as missed. */
export const MISSED_AFTER_MIN = 60;

interface VitalDef { label: string; unit: string; min?: number; max?: number; bp?: boolean }
const VITAL_DEFS: Record<string, VitalDef> = {
  BP: { label: 'Blood pressure', unit: 'mmHg', bp: true },
  SUGAR_FASTING: { label: 'Sugar (fasting)', unit: 'mg/dL', min: 70, max: 130 },
  SUGAR_PP: { label: 'Sugar (after meal)', unit: 'mg/dL', min: 70, max: 180 },
  SUGAR_RANDOM: { label: 'Sugar (random)', unit: 'mg/dL', min: 70, max: 200 },
  TEMP: { label: 'Temperature', unit: '°F', min: 97, max: 99.5 },
  SPO2: { label: 'Oxygen (SpO2)', unit: '%', min: 94, max: 100 },
  PULSE: { label: 'Pulse', unit: 'bpm', min: 60, max: 100 },
  WEIGHT: { label: 'Weight', unit: 'kg' },
};
const BP_DEFAULT = { systolic_min: 90, systolic_max: 140, diastolic_min: 60, diastolic_max: 90 };

type Med = { id: string; name: string; dose: string; unit?: string; route: string; times: string[]; food_relation: string; start_date?: string; end_date?: string; instructions?: string; prescription_file_id?: string };
type Vital = { id: string; type: string; times: string[]; min?: number; max?: number; systolic_min?: number; systolic_max?: number; diastolic_min?: number; diastolic_max?: number };
type Activity = { id: string; type: string; title: string; times: string[]; duration_min?: number; notes?: string };

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const optNum = (v: unknown, f: string) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestException(`${f} must be a number.`);
  return n;
};
const list = (v: unknown) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim()).filter(Boolean);

@Injectable()
export class CarePlanService {
  private readonly logger = new Logger(CarePlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CareAccessService,
    private readonly files: CareFilesService,
  ) {}

  // ── Plan ──────────────────────────────────────────────────────────────────

  private async parsePlan(target: { series: StaffSeries; placementId: string | null }, body: Record<string, unknown>, previous: CarePlan | null) {
    const prevIds = new Set<string>([
      ...((previous?.medications as Med[]) ?? []).map((m) => m.id),
      ...((previous?.vitals as Vital[]) ?? []).map((v) => v.id),
      ...((previous?.activities as Activity[]) ?? []).map((a) => a.id),
    ]);
    // An item keeps its id across versions when the client sends it back, so
    // today's ticks stay attached to "the same medicine".
    const idFor = (raw: unknown) => {
      const id = s(raw);
      return id && prevIds.has(id) ? id : randomUUID();
    };

    const isUc = target.series === StaffSeries.UNSKILLED_CARE;
    const medsIn = Array.isArray(body.medications) ? (body.medications as Record<string, unknown>[]) : [];
    const vitalsIn = Array.isArray(body.vitals) ? (body.vitals as Record<string, unknown>[]) : [];
    // Same scope rule as the staff request: a UC may not give medicines or take vitals.
    if (isUc && (medsIn.length || vitalsIn.length)) {
      throw new BadRequestException(
        'An Unskilled Caretaker cannot give medicines or take vitals. Keep those with the family or a nurse, or ask your RM for a Skilled Caretaker (SC).',
      );
    }

    const medications: Med[] = [];
    for (const [i, m] of medsIn.entries()) {
      const f = `medications[${i}]`;
      const name = s(m.name);
      const dose = s(m.dose);
      if (!name) throw new BadRequestException(`${f}.name is required.`);
      if (!dose) throw new BadRequestException(`${f}.dose is required (e.g. "500 mg", "1 tablet").`);
      const route = (s(m.route) || 'ORAL').toUpperCase();
      if (!ROUTES.includes(route)) throw new BadRequestException(`${f}.route must be one of ${ROUTES.join(', ')}.`);
      const food = (s(m.food_relation) || 'ANY').toUpperCase();
      if (!FOOD.includes(food)) throw new BadRequestException(`${f}.food_relation must be one of ${FOOD.join(', ')}.`);
      const start = m.start_date ? parseDate(m.start_date, `${f}.start_date`) : undefined;
      const end = m.end_date ? parseDate(m.end_date, `${f}.end_date`) : undefined;
      if (start && end && end < start) throw new BadRequestException(`${f}: end_date is before start_date.`);
      if (m.prescription_file_id && !target.placementId) {
        throw new BadRequestException(`${f}: attach the prescription after the booking is confirmed.`);
      }
      const [rx] = m.prescription_file_id && target.placementId
        ? await this.files.assertOwned(target.placementId, m.prescription_file_id, 'PRESCRIPTION')
        : [undefined];
      medications.push({
        id: idFor(m.id),
        name,
        dose,
        ...(s(m.unit) ? { unit: s(m.unit) } : {}),
        route,
        times: parseTimes(m.times, `${f}.times`),
        food_relation: food,
        ...(start ? { start_date: start } : {}),
        ...(end ? { end_date: end } : {}),
        ...(s(m.instructions) ? { instructions: s(m.instructions) } : {}),
        ...(rx ? { prescription_file_id: rx } : {}),
      });
    }

    const vitals: Vital[] = [];
    for (const [i, v] of vitalsIn.entries()) {
      const f = `vitals[${i}]`;
      const type = s(v.type).toUpperCase();
      const def = VITAL_DEFS[type];
      if (!def) throw new BadRequestException(`${f}.type must be one of ${Object.keys(VITAL_DEFS).join(', ')}.`);
      const times = parseTimes(v.times, `${f}.times`);
      if (def.bp) {
        const r = {
          systolic_min: optNum(v.systolic_min, `${f}.systolic_min`) ?? BP_DEFAULT.systolic_min,
          systolic_max: optNum(v.systolic_max, `${f}.systolic_max`) ?? BP_DEFAULT.systolic_max,
          diastolic_min: optNum(v.diastolic_min, `${f}.diastolic_min`) ?? BP_DEFAULT.diastolic_min,
          diastolic_max: optNum(v.diastolic_max, `${f}.diastolic_max`) ?? BP_DEFAULT.diastolic_max,
        };
        if (r.systolic_min >= r.systolic_max || r.diastolic_min >= r.diastolic_max) throw new BadRequestException(`${f}: each min must be below its max.`);
        vitals.push({ id: idFor(v.id), type, times, ...r });
      } else {
        const min = optNum(v.min, `${f}.min`) ?? def.min;
        const max = optNum(v.max, `${f}.max`) ?? def.max;
        if (min !== undefined && max !== undefined && min >= max) throw new BadRequestException(`${f}: min must be below max.`);
        vitals.push({ id: idFor(v.id), type, times, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
      }
    }

    const activities: Activity[] = [];
    for (const [i, a] of (Array.isArray(body.activities) ? (body.activities as Record<string, unknown>[]) : []).entries()) {
      const f = `activities[${i}]`;
      const type = (s(a.type) || 'OTHER').toUpperCase();
      if (!ACTIVITY_TYPES.includes(type)) throw new BadRequestException(`${f}.type must be one of ${ACTIVITY_TYPES.join(', ')}.`);
      const title = s(a.title) || type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
      const dur = optNum(a.duration_min, `${f}.duration_min`);
      activities.push({
        id: idFor(a.id),
        type,
        title,
        times: parseTimes(a.times, `${f}.times`),
        ...(dur ? { duration_min: dur } : {}),
        ...(s(a.notes) ? { notes: s(a.notes) } : {}),
      });
    }

    const p = (body.patient ?? {}) as Record<string, unknown>;
    const patient = {
      ...(s(p.name) ? { name: s(p.name) } : {}),
      ...(optNum(p.age, 'patient.age') !== undefined ? { age: optNum(p.age, 'patient.age') } : {}),
      ...(s(p.gender) ? { gender: s(p.gender).toUpperCase() } : {}),
      conditions: list(p.conditions),
      allergies: list(p.allergies),
      ...(s(p.mobility) ? { mobility: s(p.mobility).toUpperCase() } : {}),
      ...(s(p.doctor_name) ? { doctor_name: s(p.doctor_name) } : {}),
      ...(s(p.doctor_phone) ? { doctor_phone: s(p.doctor_phone) } : {}),
      ...(s(p.emergency_contact_name) ? { emergency_contact_name: s(p.emergency_contact_name) } : {}),
      ...(s(p.emergency_contact_phone) ? { emergency_contact_phone: s(p.emergency_contact_phone) } : {}),
    };

    if (!medications.length && !vitals.length && !activities.length && !s(body.diet_notes) && !s(body.dos) && !s(body.donts)) {
      throw new BadRequestException('A care plan needs at least one medicine, vital, activity, or a note.');
    }
    return {
      patient,
      medications,
      vitals,
      activities,
      dietNotes: s(body.diet_notes) || null,
      dos: s(body.dos) || null,
      donts: s(body.donts) || null,
    };
  }

  /** What changed from `prev` to `next`, in words the staff app can show as-is. */
  private diff(prev: CarePlan | null, next: Awaited<ReturnType<CarePlanService['parsePlan']>>) {
    if (!prev) return [{ type: 'CREATED', text: 'New care plan' }];
    const out: { type: string; text: string; medical?: boolean }[] = [];
    const medText = (m: Med) => `${m.name} ${m.dose}${m.unit ? ` ${m.unit}` : ''} at ${m.times.join(', ')}`;
    const cmp = <T extends { id: string }>(a: T[], b: T[], kind: string, label: (x: T) => string, medical: boolean) => {
      const before = new Map(a.map((x) => [x.id, x]));
      const after = new Map(b.map((x) => [x.id, x]));
      for (const [id, x] of after) {
        const old = before.get(id);
        if (!old) out.push({ type: `${kind}_ADDED`, text: `${titleKind(kind)} added: ${label(x)}`, medical });
        else if (stableJson(old) !== stableJson(x)) out.push({ type: `${kind}_CHANGED`, text: `${titleKind(kind)} changed: ${label(old)} → ${label(x)}`, medical });
      }
      for (const [id, x] of before) if (!after.has(id)) out.push({ type: `${kind}_REMOVED`, text: `${titleKind(kind)} stopped: ${label(x)}`, medical });
    };
    const titleKind = (k: string) => ({ MEDICATION: 'Medicine', VITAL: 'Check', ACTIVITY: 'Activity' })[k] ?? k;
    cmp(prev.medications as Med[], next.medications, 'MEDICATION', medText, true);
    cmp(prev.vitals as Vital[], next.vitals, 'VITAL', (v) => `${VITAL_DEFS[v.type]?.label ?? v.type} at ${v.times.join(', ')}`, true);
    cmp(prev.activities as Activity[], next.activities, 'ACTIVITY', (a) => `${a.title} at ${a.times.join(', ')}`, false);
    if ((prev.dietNotes ?? '') !== (next.dietNotes ?? '')) out.push({ type: 'DIET_CHANGED', text: `Diet: ${next.dietNotes ?? '(removed)'}` });
    if ((prev.dos ?? '') !== (next.dos ?? '')) out.push({ type: 'DOS_CHANGED', text: `Do: ${next.dos ?? '(removed)'}` });
    if ((prev.donts ?? '') !== (next.donts ?? '')) out.push({ type: 'DONTS_CHANGED', text: `Don't: ${next.donts ?? '(removed)'}` });
    if (stableJson(prev.patient) !== stableJson(next.patient)) out.push({ type: 'PATIENT_CHANGED', text: 'Patient details updated' });
    return out;
  }

  async getPlan(user: AuthUser, placementId: string) {
    const ctx = await this.access.resolve(user, placementId);
    this.access.assertCare(ctx);
    const [active, versions] = await Promise.all([
      this.prisma.carePlan.findFirst({ where: { placementId, status: 'ACTIVE' } }),
      this.prisma.carePlan.findMany({
        where: { placementId },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, status: true, createdAt: true, changes: true },
      }),
    ]);
    let ack: { acknowledged_at: Date | null; seen_at: Date | null } | null = null;
    if (active) {
      const a = await this.prisma.clientInputAck.findFirst({
        where: { staffId: ctx.staff.id, inputType: 'CARE_PLAN', inputId: active.id, version: active.version },
      });
      ack = { acknowledged_at: a?.acknowledgedAt ?? null, seen_at: a?.seenAt ?? null };
    }
    return {
      placement_id: placementId,
      staff: { id: ctx.staff.id, name: ctx.staff.fullName, series: ctx.staff.series },
      client: { id: ctx.client.id, name: ctx.client.customerName },
      plan: active ? this.planDto(active) : null,
      staff_acknowledged_at: ack?.acknowledged_at ?? null,
      versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, created_at: v.createdAt, changes: v.changes })),
      vital_types: Object.entries(VITAL_DEFS).map(([k, d]) => ({ type: k, label: d.label, unit: d.unit, default_min: d.min, default_max: d.max, ...(d.bp ? BP_DEFAULT : {}) })),
    };
  }

  planDto(p: CarePlan) {
    return {
      id: p.id,
      version: p.version,
      status: p.status,
      patient: p.patient,
      medications: p.medications,
      vitals: (p.vitals as Vital[]).map((v) => ({ ...v, label: VITAL_DEFS[v.type]?.label, unit: VITAL_DEFS[v.type]?.unit })),
      activities: p.activities,
      diet_notes: p.dietNotes,
      dos: p.dos,
      donts: p.donts,
      changes: p.changes,
      created_at: p.createdAt,
    };
  }

  /** The client writes (or rewrites) the plan. Always a new version. */
  async savePlan(user: AuthUser, placementId: string, body: Record<string, unknown>) {
    const ctx = await this.access.resolve(user, placementId, { write: true });
    if (ctx.role !== 'CLIENT') throw new BadRequestException('Only the client writes the care plan.');
    this.access.assertCare(ctx);

    const prev = await this.prisma.carePlan.findFirst({ where: { placementId, status: 'ACTIVE' } });
    const parsed = await this.parsePlan({ series: ctx.staff.series, placementId }, body, prev);
    const changes = this.diff(prev, parsed);
    if (prev && !changes.length) return this.getPlan(user, placementId);
    await this.writeVersion(ctx, parsed, changes, user.id);
    return this.getPlan(user, placementId);
  }

  /**
   * Checks care needs sent with a staff request, before there is a placement —
   * the same rules as the care plan (UC: no medicines or vitals).
   */
  async validateCareNeeds(series: StaffSeries, body: Record<string, unknown>) {
    return this.parsePlan({ series, placementId: null }, body, null);
  }

  /**
   * The care needs from the request become care plan v1 when the RM places the
   * staff — unless the placement already has a plan.
   */
  async createFromRequest(placementId: string, careNeeds: Record<string, unknown>, actorId: string | null) {
    const ctx = await this.access.resolve({ id: '', role: 'ADMIN' }, placementId);
    if (!CARE_SERIES.includes(ctx.staff.series)) return null;
    const existing = await this.prisma.carePlan.findFirst({ where: { placementId }, select: { id: true } });
    if (existing) return null;
    const parsed = await this.parsePlan({ series: ctx.staff.series, placementId }, careNeeds, null);
    const changes = [{ type: 'CREATED', text: 'Care plan from your booking' }];
    return this.writeVersion(ctx, parsed, changes, actorId);
  }

  private async writeVersion(
    ctx: PlacementCtx,
    parsed: Awaited<ReturnType<CarePlanService['parsePlan']>>,
    changes: { type: string; text: string; medical?: boolean }[],
    actorId: string | null,
  ) {
    const placementId = ctx.placement.id;
    const created = await this.prisma.$transaction(async (tx) => {
      // One writer at a time per placement, so two saves can't both become ACTIVE.
      await tx.$queryRaw`SELECT id FROM placements WHERE id = ${placementId}::uuid FOR UPDATE`;
      const cur = await tx.carePlan.findFirst({ where: { placementId, status: 'ACTIVE' } });
      const last = await tx.carePlan.findFirst({ where: { placementId }, orderBy: { version: 'desc' }, select: { version: true } });
      if (cur) await tx.carePlan.update({ where: { id: cur.id }, data: { status: 'SUPERSEDED', supersededAt: new Date() } });
      return tx.carePlan.create({
        data: {
          placementId,
          clientId: ctx.client.id,
          version: (last?.version ?? 0) + 1,
          status: 'ACTIVE',
          patient: parsed.patient as Prisma.InputJsonValue,
          medications: parsed.medications as unknown as Prisma.InputJsonValue,
          vitals: parsed.vitals as unknown as Prisma.InputJsonValue,
          activities: parsed.activities as unknown as Prisma.InputJsonValue,
          dietNotes: parsed.dietNotes,
          dos: parsed.dos,
          donts: parsed.donts,
          changes: changes as unknown as Prisma.InputJsonValue,
          createdBy: actorId,
          metadata: { medical_change: changes.some((c) => c.medical) } as Prisma.InputJsonValue,
        },
      });
    });

    // Today's not-yet-done ticks move to the new plan; done ones stay as they were.
    const today = istNow().date;
    await this.prisma.careTask.deleteMany({
      where: { placementId, taskDate: { gte: dbDate(today) }, status: 'PENDING', planId: { not: created.id } },
    });
    await this.ensureTasks(created, today);

    await this.access.notify(
      [ctx.staff.userId],
      created.version === 1 ? 'Care plan from the family' : 'Care plan changed — please read',
      changes.slice(0, 3).map((c) => c.text).join(' · ') + (changes.length > 3 ? ` · +${changes.length - 3} more` : ''),
      'CARE_PLAN_UPDATED',
      { placement_id: placementId, plan_id: created.id, version: created.version },
    );
    return created;
  }

  // ── Daily checklist ───────────────────────────────────────────────────────

  /** Creates the plan's tasks for `date` if they don't exist yet. Idempotent. */
  private async ensureTasks(plan: CarePlan, date: string) {
    const rows: Prisma.CareTaskCreateManyInput[] = [];
    const base = { placementId: plan.placementId, planId: plan.id, taskDate: dbDate(date) };
    for (const m of plan.medications as Med[]) {
      if ((m.start_date && date < m.start_date) || (m.end_date && date > m.end_date)) continue;
      const food = m.food_relation && m.food_relation !== 'ANY' ? ` · ${m.food_relation.toLowerCase()} food` : '';
      for (const t of m.times) rows.push({ ...base, sourceType: 'MEDICATION', sourceId: m.id, scheduledTime: t, title: `${m.name} ${m.dose}${m.unit ? ` ${m.unit}` : ''}${food}`.slice(0, 255) });
    }
    for (const v of plan.vitals as Vital[]) {
      for (const t of v.times) rows.push({ ...base, sourceType: 'VITAL', sourceId: v.id, scheduledTime: t, title: `Check ${VITAL_DEFS[v.type]?.label ?? v.type}` });
    }
    for (const a of plan.activities as Activity[]) {
      for (const t of a.times) rows.push({ ...base, sourceType: 'ACTIVITY', sourceId: a.id, scheduledTime: t, title: `${a.title}${a.duration_min ? ` (${a.duration_min} min)` : ''}`.slice(0, 255) });
    }
    if (rows.length) await this.prisma.careTask.createMany({ data: rows, skipDuplicates: true });
  }

  /** PENDING past its grace time → MISSED. Earlier days are entirely closed. */
  private async markMissed(placementId?: string) {
    const now = istNow();
    const where = placementId ? Prisma.sql`AND placement_id = ${placementId}::uuid` : Prisma.empty;
    await this.prisma.$executeRaw`
      UPDATE care_tasks SET status = 'MISSED', updated_at = NOW()
       WHERE status = 'PENDING' ${where}
         AND (task_date < ${dbDate(now.date)}::date
              OR (task_date = ${dbDate(now.date)}::date
                  AND (split_part(scheduled_time, ':', 1)::int * 60 + split_part(scheduled_time, ':', 2)::int) + ${MISSED_AFTER_MIN} < ${now.minutes}))`;
  }

  private taskDto(t: CareTask, plan?: CarePlan | null) {
    let target: Record<string, unknown> | undefined;
    if (t.sourceType === 'VITAL' && plan) {
      const v = (plan.vitals as Vital[]).find((x) => x.id === t.sourceId);
      if (v) target = { type: v.type, unit: VITAL_DEFS[v.type]?.unit, min: v.min, max: v.max, systolic_min: v.systolic_min, systolic_max: v.systolic_max, diastolic_min: v.diastolic_min, diastolic_max: v.diastolic_max };
    }
    if (t.sourceType === 'MEDICATION' && plan) {
      const m = (plan.medications as Med[]).find((x) => x.id === t.sourceId);
      if (m) target = { route: m.route, food_relation: m.food_relation, instructions: m.instructions, prescription_file_id: m.prescription_file_id };
    }
    return {
      id: t.id,
      date: dateStr(t.taskDate),
      type: t.sourceType,
      item_id: t.sourceId,
      title: t.title,
      time: t.scheduledTime,
      status: t.status,
      value: t.value,
      out_of_range: t.outOfRange,
      skip_reason: t.skipReason,
      notes: t.notes,
      photo_file_ids: t.photoFileIds,
      done_at: t.doneAt,
      ...(target ? { target } : {}),
    };
  }

  /** The checklist and report for one day — what the client and RM look at. */
  async getDay(user: AuthUser, placementId: string, date?: string) {
    const ctx = await this.access.resolve(user, placementId);
    this.access.assertCare(ctx);
    const d = date ? parseDate(date) : istNow().date;
    const plan = await this.prisma.carePlan.findFirst({ where: { placementId, status: 'ACTIVE' } });
    if (plan && ctx.active && d === istNow().date) await this.ensureTasks(plan, d);
    await this.markMissed(placementId);
    const [tasks, report] = await Promise.all([
      this.prisma.careTask.findMany({ where: { placementId, taskDate: dbDate(d) }, orderBy: [{ scheduledTime: 'asc' }, { sourceType: 'asc' }] }),
      this.prisma.dailyCareReport.findUnique({ where: { placementId_reportDate: { placementId, reportDate: dbDate(d) } } }),
    ]);
    const plans = new Map<string, CarePlan>();
    for (const id of new Set(tasks.map((t) => t.planId))) {
      const p = id === plan?.id ? plan : await this.prisma.carePlan.findUnique({ where: { id } });
      if (p) plans.set(id, p);
    }
    const count = (st: string) => tasks.filter((t) => t.status === st).length;
    const due = tasks.filter((t) => t.status !== 'PENDING').length;
    return {
      placement_id: placementId,
      date: d,
      plan_version: plan?.version ?? null,
      summary: {
        total: tasks.length,
        done: count('DONE'),
        pending: count('PENDING'),
        missed: count('MISSED'),
        skipped: count('SKIPPED'),
        out_of_range: tasks.filter((t) => t.outOfRange).length,
        adherence_pct: due ? Math.round((count('DONE') / due) * 100) : null,
      },
      tasks: tasks.map((t) => this.taskDto(t, plans.get(t.planId))),
      report: report ? this.reportDto(report) : null,
    };
  }

  /** Per-day adherence and every vital reading, for the client's history screen and the monthly report. */
  async history(user: AuthUser, placementId: string, from?: string, to?: string) {
    const ctx = await this.access.resolve(user, placementId);
    this.access.assertCare(ctx);
    const end = to ? parseDate(to, 'to') : istNow().date;
    const start = from ? parseDate(from, 'from') : addDays(end, -6);
    if (start > end) throw new BadRequestException('from is after to.');
    if (Date.parse(end) - Date.parse(start) > 92 * 86_400_000) throw new BadRequestException('At most 92 days at a time.');
    await this.markMissed(placementId);
    const tasks = await this.prisma.careTask.findMany({
      where: { placementId, taskDate: { gte: dbDate(start), lte: dbDate(end) } },
      orderBy: [{ taskDate: 'asc' }, { scheduledTime: 'asc' }],
    });
    const days = new Map<string, CareTask[]>();
    for (const t of tasks) days.set(dateStr(t.taskDate), [...(days.get(dateStr(t.taskDate)) ?? []), t]);
    const meds = tasks.filter((t) => t.sourceType === 'MEDICATION' && t.status !== 'PENDING');
    return {
      placement_id: placementId,
      from: start,
      to: end,
      medication_adherence_pct: meds.length ? Math.round((meds.filter((t) => t.status === 'DONE').length / meds.length) * 100) : null,
      missed_doses: meds.filter((t) => t.status === 'MISSED').length,
      days: [...days.entries()].map(([date, ts]) => {
        const due = ts.filter((t) => t.status !== 'PENDING');
        return {
          date,
          total: ts.length,
          done: ts.filter((t) => t.status === 'DONE').length,
          missed: ts.filter((t) => t.status === 'MISSED').length,
          skipped: ts.filter((t) => t.status === 'SKIPPED').length,
          adherence_pct: due.length ? Math.round((due.filter((t) => t.status === 'DONE').length / due.length) * 100) : null,
        };
      }),
      vitals: tasks
        .filter((t) => t.sourceType === 'VITAL' && t.status === 'DONE')
        .map((t) => ({ date: dateStr(t.taskDate), time: t.scheduledTime, title: t.title, value: t.value, out_of_range: t.outOfRange })),
    };
  }

  // ── Staff actions ─────────────────────────────────────────────────────────

  private async taskForStaff(user: AuthUser, taskId: string) {
    const task = await this.prisma.careTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found.');
    const ctx = await this.access.resolve(user, task.placementId, { write: true });
    if (ctx.role !== 'STAFF') throw new BadRequestException('Only the caretaker ticks the checklist.');
    assertLoggableDate(dateStr(task.taskDate));
    return { task, ctx };
  }

  /** Did it. A vital needs its reading; a reading outside the range raises an alert at once. */
  async markDone(user: AuthUser, taskId: string, body: Record<string, unknown>) {
    const { task, ctx } = await this.taskForStaff(user, taskId);
    if (task.status === 'DONE') throw new BadRequestException('Already done.');
    const photos = await this.files.assertOwned(ctx.placement.id, body.photo_file_ids, 'PHOTO');

    let value: Record<string, unknown> | null = null;
    let outOfRange = false;
    let critical = false;
    let readingText = '';
    if (task.sourceType === 'VITAL') {
      const plan = await this.prisma.carePlan.findUnique({ where: { id: task.planId } });
      const v = (plan?.vitals as Vital[] | undefined)?.find((x) => x.id === task.sourceId);
      const raw = (typeof body.value === 'string' ? JSON.parse(body.value) : body.value ?? {}) as Record<string, unknown>;
      if (v?.type === 'BP') {
        const sys = Number(raw.systolic);
        const dia = Number(raw.diastolic);
        if (!(sys > 0) || !(dia > 0)) throw new BadRequestException('Blood pressure needs value.systolic and value.diastolic.');
        value = { systolic: sys, diastolic: dia, unit: 'mmHg' };
        readingText = `${sys}/${dia} mmHg`;
        outOfRange = sys < v.systolic_min! || sys > v.systolic_max! || dia < v.diastolic_min! || dia > v.diastolic_max!;
        critical = sys >= 180 || sys < 80 || dia >= 120 || dia < 50;
      } else {
        const n = Number(raw.value);
        if (!Number.isFinite(n)) throw new BadRequestException('This check needs value.value (a number).');
        const unit = VITAL_DEFS[v?.type ?? '']?.unit;
        value = { value: n, unit };
        readingText = `${n} ${unit ?? ''}`.trim();
        if (v?.min !== undefined && n < v.min) outOfRange = true;
        if (v?.max !== undefined && n > v.max) outOfRange = true;
        // Far outside: 20% beyond the range, or SpO2 under 90.
        if (v?.min !== undefined && n < v.min * 0.8) critical = true;
        if (v?.max !== undefined && n > v.max * 1.2) critical = true;
        if (v?.type === 'SPO2' && n < 90) critical = true;
      }
    }

    const late = task.status === 'MISSED';
    const updated = await this.prisma.careTask.update({
      where: { id: task.id },
      data: {
        status: 'DONE',
        doneAt: new Date(),
        doneBy: ctx.staff.id,
        value: (value ?? (late ? { late: true } : undefined)) as Prisma.InputJsonValue | undefined,
        outOfRange,
        notes: String(body.notes ?? '').trim() || null,
        photoFileIds: photos as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
    });

    if (outOfRange) {
      const severity = critical ? 'CRITICAL' : 'HIGH';
      await this.prisma.escalationLog.create({
        data: {
          staffId: ctx.staff.id,
          clientId: ctx.client.id,
          severity,
          title: `${task.title}: ${readingText} is outside the safe range`,
          description: `Recorded by ${ctx.staff.fullName} at ${istNow().hhmm} IST for ${ctx.client.customerName}.`,
          metadata: { placement_id: ctx.placement.id, care_task_id: task.id, value } as Prisma.InputJsonValue,
        },
      });
      const rm = await this.access.rmOf(ctx);
      const who = [ctx.client.userId, rm, ...(critical ? await this.access.bmsOf(ctx.placement.branchId) : [])];
      await this.access.notify(
        who,
        critical ? '⚠ Urgent: reading far out of range' : 'Reading out of range',
        `${task.title}: ${readingText} (${ctx.client.customerName}).`,
        'CARE_VITAL_ALERT',
        { placement_id: ctx.placement.id, task_id: task.id, severity },
      );
    }
    const plan = await this.prisma.carePlan.findUnique({ where: { id: updated.planId } });
    return this.taskDto(updated, plan);
  }

  async skip(user: AuthUser, taskId: string, body: Record<string, unknown>) {
    const { task } = await this.taskForStaff(user, taskId);
    if (task.status === 'DONE') throw new BadRequestException('Already done.');
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Say why it was skipped — the family sees this.');
    const updated = await this.prisma.careTask.update({
      where: { id: task.id },
      data: { status: 'SKIPPED', skipReason: reason, updatedAt: new Date() },
    });
    return this.taskDto(updated);
  }

  /** The caretaker's own view: every active care placement, today's list, today's report. */
  async staffToday(user: AuthUser) {
    const staff = await this.access.staffForUser(user.id);
    if (!staff.series || !CARE_SERIES.includes(staff.series)) return { date: istNow().date, placements: [] };
    const placements = await this.access.activePlacementsForStaff(staff.id);
    const out: Record<string, unknown>[] = [];
    for (const { placement, client } of placements) {
      const day = await this.getDay(user, placement.id);
      const plan = await this.prisma.carePlan.findFirst({ where: { placementId: placement.id, status: 'ACTIVE' }, select: { id: true, version: true, changes: true } });
      const ack = plan
        ? await this.prisma.clientInputAck.findFirst({ where: { staffId: staff.id, inputType: 'CARE_PLAN', inputId: plan.id, version: plan.version } })
        : null;
      out.push({
        placement_id: placement.id,
        client: { id: placement.clientId, name: client?.customerName ?? null, address: client?.address ?? null },
        plan: plan ? { id: plan.id, version: plan.version, acknowledged: !!ack?.acknowledgedAt, changes: ack?.acknowledgedAt ? [] : plan.changes } : null,
        summary: day.summary,
        tasks: day.tasks,
        report: day.report,
      });
    }
    return { date: istNow().date, placements: out };
  }

  // ── Daily report ──────────────────────────────────────────────────────────

  reportDto(r: { id: string; reportDate: Date; meals: Prisma.JsonValue; fluidIntakeMl: number | null; sleep: string | null; mood: string | null; hygiene: Prisma.JsonValue; notes: string | null; photoFileIds: Prisma.JsonValue; submittedAt: Date; updatedAt: Date }) {
    return {
      id: r.id,
      date: dateStr(r.reportDate),
      meals: r.meals,
      fluid_intake_ml: r.fluidIntakeMl,
      sleep: r.sleep,
      mood: r.mood,
      hygiene: r.hygiene,
      notes: r.notes,
      photo_file_ids: r.photoFileIds,
      submitted_at: r.submittedAt,
      updated_at: r.updatedAt,
    };
  }

  async saveReport(user: AuthUser, body: Record<string, unknown>) {
    const placementId = String(body.placement_id ?? '');
    if (!placementId) throw new BadRequestException('placement_id is required.');
    const ctx = await this.access.resolve(user, placementId, { write: true });
    if (ctx.role !== 'STAFF') throw new BadRequestException('Only the caretaker writes the daily report.');
    this.access.assertCare(ctx);
    const date = body.date ? parseDate(body.date) : istNow().date;
    assertLoggableDate(date);
    const photos = await this.files.assertOwned(placementId, body.photo_file_ids, 'PHOTO');
    const meals = Array.isArray(body.meals)
      ? (body.meals as Record<string, unknown>[]).map((m) => ({ meal: s(m.meal).toUpperCase(), description: s(m.description), quantity: s(m.quantity) || undefined }))
      : [];
    const fluid = optNum(body.fluid_intake_ml, 'fluid_intake_ml');
    const data = {
      staffId: ctx.staff.id,
      meals: meals as Prisma.InputJsonValue,
      fluidIntakeMl: fluid !== undefined ? Math.round(fluid) : null,
      sleep: s(body.sleep) || null,
      mood: s(body.mood) || null,
      hygiene: ((body.hygiene && typeof body.hygiene === 'object') ? body.hygiene : {}) as Prisma.InputJsonValue,
      notes: s(body.notes) || null,
      photoFileIds: photos as Prisma.InputJsonValue,
      updatedAt: new Date(),
    };
    const row = await this.prisma.dailyCareReport.upsert({
      where: { placementId_reportDate: { placementId, reportDate: dbDate(date) } },
      update: data,
      create: { ...data, placementId, reportDate: dbDate(date) },
    });
    return this.reportDto(row);
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────

  /**
   * Hourly: make today's checklist for every active care plan, close what is
   * overdue, and tell the client and RM once per missed dose.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweep() {
    const today = istNow().date;
    const plans = await this.prisma.carePlan.findMany({
      where: { status: 'ACTIVE', placement: { status: { in: ACTIVE_PLACEMENT as never } } },
    });
    for (const p of plans) await this.ensureTasks(p, today).catch((e) => this.logger.warn(`ensureTasks ${p.id}: ${e.message}`));
    await this.markMissed();
    const missed = await this.prisma.careTask.findMany({
      where: { sourceType: 'MEDICATION', status: 'MISSED', notifiedAt: null, taskDate: { gte: dbDate(addDays(today, -1)) } },
      take: 500,
    });
    for (const t of missed) {
      const ctx = await this.access.resolve({ id: '', role: 'ADMIN' }, t.placementId).catch(() => null);
      if (ctx) {
        await this.access.notify(
          [ctx.client.userId, await this.access.rmOf(ctx)],
          'Medicine dose missed',
          `${t.title} due at ${t.scheduledTime} on ${dateStr(t.taskDate)} was not marked given (${ctx.client.customerName}).`,
          'CARE_DOSE_MISSED',
          { placement_id: t.placementId, task_id: t.id },
        );
      }
      await this.prisma.careTask.update({ where: { id: t.id }, data: { notifiedAt: new Date() } });
    }
    return { plans: plans.length, missed_notified: missed.length };
  }
}

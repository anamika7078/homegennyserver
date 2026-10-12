import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, StaffSeries } from '@prisma/client';
import PDFDocument = require('pdfkit');
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import { ACTIVE_PLACEMENT, CareAccessService, CARE_SERIES, addDays, dateStr, dbDate, istNow } from './care-access.service';
import { CarePlanService } from './care-plan.service';
import { CookService } from './cook.service';
import { InstructionsService } from './instructions.service';

/**
 * The rule that runs through Phases C–E: whatever the client puts in the app
 * for their staff, the staff sees — and the client can see that they saw it.
 *
 *   GET  /staff/client-updates            every client input, newest first, with what changed
 *   POST /staff/client-updates/:type/:id/ack   "Padh liya"
 *
 * Plus the two things built on top of the same data: the RM's compliance
 * board and the client's monthly PDF.
 */

export const INPUT_TYPES = ['CARE_PLAN', 'FOOD_PROFILE', 'MENU', 'INSTRUCTION', 'MEAL_FEEDBACK'] as const;
type InputType = (typeof INPUT_TYPES)[number];
/** A medical care-plan change unread this long → the RM is told. */
const UNREAD_ALERT_HOURS = 2;

export interface FeedItem {
  type: InputType;
  id: string;
  version: number;
  placement_id: string;
  client_name: string | null;
  title: string;
  changes: string[];
  at: Date;
  seen_at: Date | null;
  acknowledged_at: Date | null;
}

@Injectable()
export class ClientUpdatesService {
  private readonly logger = new Logger(ClientUpdatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CareAccessService,
    private readonly care: CarePlanService,
    private readonly cook: CookService,
    private readonly instructions: InstructionsService,
  ) {}

  // ── Staff feed ────────────────────────────────────────────────────────────

  async feed(user: AuthUser, q: { placement_id?: string; unread?: string }) {
    const staff = await this.access.staffForUser(user.id);
    let placements = await this.access.activePlacementsForStaff(staff.id);
    if (q.placement_id) placements = placements.filter((p) => p.placement.id === q.placement_id);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const today = istNow().date;
    const items: Omit<FeedItem, 'seen_at' | 'acknowledged_at'>[] = [];

    for (const { placement, client } of placements) {
      const base = { placement_id: placement.id, client_name: client?.customerName ?? null };
      if (CARE_SERIES.includes(staff.series)) {
        const plan = await this.prisma.carePlan.findFirst({ where: { placementId: placement.id, status: 'ACTIVE' } });
        if (plan) {
          items.push({
            ...base, type: 'CARE_PLAN', id: plan.id, version: plan.version, at: plan.createdAt,
            title: plan.version === 1 ? 'Care plan from the family' : `Care plan changed (v${plan.version})`,
            changes: ((plan.changes as { text: string }[]) ?? []).map((c) => c.text),
          });
        }
      }
      if (staff.series === StaffSeries.COOK) {
        const profile = await this.prisma.foodProfile.findUnique({ where: { clientId: placement.clientId } });
        if (profile) {
          const dto = this.cook.profileDto(profile)!;
          items.push({ ...base, type: 'FOOD_PROFILE', id: profile.id, version: profile.version, at: profile.updatedAt, title: 'Food preferences', changes: dto.changes });
        }
        const menus = await this.prisma.menuPlan.findMany({
          where: {
            placementId: placement.id,
            menuDate: { gte: dbDate(today) },
            // The family's own entries, and their answers to the cook's suggestions.
            OR: [{ createdByRole: 'CLIENT' }, { status: { in: ['APPROVED', 'REJECTED'] } }],
          },
          orderBy: { menuDate: 'asc' },
          take: 60,
        });
        for (const m of menus) {
          const dto = this.cook.menuDto(m);
          const dishes = ((m.dishes as { name: string }[]) ?? []).map((d) => d.name).join(', ');
          const what =
            m.status === 'APPROVED' ? `approved: ${dishes}` : m.status === 'REJECTED' ? `declined — ${m.rejectReason ?? ''}` : dishes;
          items.push({
            ...base, type: 'MENU', id: m.id, version: m.version, at: m.updatedAt,
            title: `${dateStr(m.menuDate)} ${m.meal.toLowerCase()}: ${what}`.slice(0, 200),
            changes: [...dto.changes, ...(m.specialInstruction ? [`Note: ${m.specialInstruction}`] : [])],
          });
        }
        const fb = await this.prisma.mealFeedback.findMany({
          where: { mealLog: { placementId: placement.id }, updatedAt: { gt: since } },
          include: { mealLog: { select: { meal: true, mealDate: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 30,
        });
        for (const f of fb) {
          items.push({
            ...base, type: 'MEAL_FEEDBACK', id: f.id, version: 1, at: f.updatedAt,
            title: `${dateStr(f.mealLog.mealDate)} ${f.mealLog.meal.toLowerCase()}: ${f.rating}/5`,
            changes: [((f.tags as string[]) ?? []).map((t) => t.replace(/_/g, ' ').toLowerCase()).join(', '), f.comment ?? ''].filter(Boolean),
          });
        }
      }
      const ins = await this.prisma.clientInstruction.findMany({
        where: { placementId: placement.id, staffId: staff.id, status: { not: 'CANCELLED' }, createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      for (const i of ins) {
        items.push({
          ...base, type: 'INSTRUCTION', id: i.id, version: 1, at: i.createdAt,
          title: i.text ? i.text.slice(0, 200) : 'Voice note from the family',
          changes: [i.kind === 'RECURRING' ? 'Every day (standing order)' : '', i.dueAt ? `By ${i.dueAt.toISOString()}` : '', `Status: ${i.status}`].filter(Boolean),
        });
      }
    }

    // Seen = it reached the app. Instructions carry their own "samjha" (acknowledged_at).
    const acks = items.length
      ? await this.prisma.clientInputAck.findMany({ where: { staffId: staff.id, inputId: { in: items.map((i) => i.id) } } })
      : [];
    const ackOf = (i: { type: string; id: string; version: number }) => acks.find((a) => a.inputType === i.type && a.inputId === i.id && a.version === i.version);
    const insAck = new Map(
      (await this.prisma.clientInstruction.findMany({ where: { id: { in: items.filter((i) => i.type === 'INSTRUCTION').map((i) => i.id) } }, select: { id: true, acknowledgedAt: true } }))
        .map((r) => [r.id, r.acknowledgedAt]),
    );
    const unseen = items.filter((i) => !ackOf(i));
    if (unseen.length) {
      await this.prisma.clientInputAck.createMany({
        data: unseen.map((i) => ({ placementId: i.placement_id, staffId: staff.id, inputType: i.type, inputId: i.id, version: i.version, seenAt: new Date() })),
        skipDuplicates: true,
      });
    }
    let out: FeedItem[] = items.map((i) => {
      const a = ackOf(i);
      return {
        ...i,
        seen_at: a?.seenAt ?? new Date(),
        acknowledged_at: i.type === 'INSTRUCTION' ? insAck.get(i.id) ?? null : a?.acknowledgedAt ?? null,
      };
    });
    out.sort((a, b) => b.at.getTime() - a.at.getTime());
    const unread = out.filter((i) => !i.acknowledged_at).length;
    if (q.unread === 'true') out = out.filter((i) => !i.acknowledged_at);
    return { items: out, unread };
  }

  async unreadCount(user: AuthUser) {
    const { unread } = await this.feed(user, {});
    return { unread };
  }

  /** "Padh liya". For an instruction it is the same as "samjha". */
  async ack(user: AuthUser, type: string, id: string) {
    const t = String(type).toUpperCase() as InputType;
    if (!INPUT_TYPES.includes(t)) throw new BadRequestException(`type must be one of ${INPUT_TYPES.join(', ')}.`);
    const staff = await this.access.staffForUser(user.id);
    if (t === 'INSTRUCTION') {
      const ins = await this.prisma.clientInstruction.findUnique({ where: { id } });
      if (!ins || ins.staffId !== staff.id) throw new BadRequestException('Not one of your instructions.');
      if (ins.status === 'SENT') return { type: t, id, acknowledged: true, instruction: await this.instructions.acknowledge(user, id) };
      return { type: t, id, acknowledged: true };
    }
    const { items } = await this.feed(user, {});
    const item = items.find((i) => i.type === t && i.id === id);
    if (!item) throw new BadRequestException('That is not in your updates (or a newer version replaced it).');
    await this.prisma.clientInputAck.upsert({
      where: { staffId_inputType_inputId_version: { staffId: staff.id, inputType: t, inputId: id, version: item.version } },
      update: { acknowledgedAt: new Date() },
      create: { placementId: item.placement_id, staffId: staff.id, inputType: t, inputId: id, version: item.version, seenAt: new Date(), acknowledgedAt: new Date() },
    });
    if (t === 'CARE_PLAN') {
      const ctx = await this.access.resolve({ id: '', role: 'ADMIN' }, item.placement_id);
      await this.access.notify([ctx.client.userId], `${ctx.staff.fullName.split(' ')[0]} read the care plan`, `Version ${item.version}`, 'CARE_PLAN_ACKNOWLEDGED', { placement_id: item.placement_id, plan_id: id });
    }
    return { type: t, id, version: item.version, acknowledged: true };
  }

  /** Every 30 min: a medical care-plan change still unread after 2 hours → tell the RM, once. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async alertUnreadPlans() {
    const cutoff = new Date(Date.now() - UNREAD_ALERT_HOURS * 3_600_000);
    const plans = await this.prisma.carePlan.findMany({
      where: { status: 'ACTIVE', createdAt: { lt: cutoff, gt: new Date(Date.now() - 3 * 86_400_000) }, placement: { status: { in: ACTIVE_PLACEMENT as never } } },
    });
    let n = 0;
    for (const p of plans) {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      if (!meta.medical_change || meta.unread_alerted_at) continue;
      const ctx = await this.access.resolve({ id: '', role: 'ADMIN' }, p.placementId).catch(() => null);
      if (!ctx) continue;
      const ack = await this.prisma.clientInputAck.findFirst({
        where: { staffId: ctx.staff.id, inputType: 'CARE_PLAN', inputId: p.id, version: p.version, acknowledgedAt: { not: null } },
      });
      if (ack) continue;
      await this.access.notify(
        [await this.access.rmOf(ctx)],
        'Care plan change not read',
        `${ctx.staff.fullName} has not read the medicine change at ${ctx.client.customerName} (${UNREAD_ALERT_HOURS}h+). Please call them.`,
        'CARE_PLAN_UNREAD',
        { placement_id: p.placementId, plan_id: p.id },
      );
      await this.prisma.carePlan.update({ where: { id: p.id }, data: { metadata: { ...meta, unread_alerted_at: new Date().toISOString() } as Prisma.InputJsonValue } });
      n++;
    }
    return n;
  }

  // ── RM compliance board ───────────────────────────────────────────────────

  async compliance(user: AuthUser) {
    const where: Prisma.PlacementWhereInput = { status: { in: ACTIVE_PLACEMENT as never } };
    if (user.role === 'RM') where.rmId = user.id;
    if (user.role === 'BM' && user.branchId) where.branchId = user.branchId;
    const placements = await this.prisma.placement.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
    const today = istNow().date;
    const weekAgo = dbDate(addDays(today, -6));
    const rows: Record<string, unknown>[] = [];
    for (const p of placements) {
      const ctx = await this.access.resolve({ id: '', role: 'ADMIN' }, p.id).catch(() => null);
      if (!ctx) continue;
      const isCare = CARE_SERIES.includes(ctx.staff.series);
      const isCook = ctx.staff.series === StaffSeries.COOK;
      if (!isCare && !isCook) continue;
      const flags: string[] = [];
      const row: Record<string, unknown> = {
        placement_id: p.id,
        staff: { id: ctx.staff.id, name: ctx.staff.fullName, series: ctx.staff.series },
        client: { id: ctx.client.id, name: ctx.client.customerName },
      };
      if (isCare) {
        const [plan, todayTasks, missed7, alerts7, report] = await Promise.all([
          this.prisma.carePlan.findFirst({ where: { placementId: p.id, status: 'ACTIVE' }, select: { id: true, version: true } }),
          this.prisma.careTask.findMany({ where: { placementId: p.id, taskDate: dbDate(today) }, select: { status: true } }),
          this.prisma.careTask.count({ where: { placementId: p.id, sourceType: 'MEDICATION', status: 'MISSED', taskDate: { gte: weekAgo } } }),
          this.prisma.careTask.count({ where: { placementId: p.id, outOfRange: true, taskDate: { gte: weekAgo } } }),
          this.prisma.dailyCareReport.findUnique({ where: { placementId_reportDate: { placementId: p.id, reportDate: dbDate(today) } }, select: { id: true } }),
        ]);
        const planRead = plan
          ? !!(await this.prisma.clientInputAck.findFirst({ where: { staffId: ctx.staff.id, inputType: 'CARE_PLAN', inputId: plan.id, version: plan.version, acknowledgedAt: { not: null } } }))
          : null;
        if (!plan) flags.push('No care plan yet');
        if (missed7) flags.push(`${missed7} missed dose(s) this week`);
        if (alerts7) flags.push(`${alerts7} reading(s) out of range this week`);
        if (plan && !planRead) flags.push('Care plan not read');
        if (!report && istNow().minutes > 20 * 60) flags.push("Today's report not filled");
        row.care = {
          plan_version: plan?.version ?? null,
          plan_read: planRead,
          today: { total: todayTasks.length, done: todayTasks.filter((t) => t.status === 'DONE').length, missed: todayTasks.filter((t) => t.status === 'MISSED').length },
          missed_doses_7d: missed7,
          vital_alerts_7d: alerts7,
          report_today: !!report,
        };
      }
      if (isCook) {
        const [rating, mealsToday] = await Promise.all([
          this.cook.ratingStats(p.id),
          this.prisma.mealLog.count({ where: { placementId: p.id, mealDate: dbDate(today) } }),
        ]);
        if (rating.avg_7d !== null && rating.avg_7d < 3) flags.push(`Rating ${rating.avg_7d}/5 this week`);
        row.cook = { rating, meals_logged_today: mealsToday };
      }
      const [pending, refused] = await Promise.all([
        this.prisma.clientInstruction.count({ where: { placementId: p.id, status: 'SENT' } }),
        this.prisma.clientInstruction.count({ where: { placementId: p.id, status: 'REFUSED', rmDecision: null } }),
      ]);
      if (refused) flags.push(`${refused} refused instruction(s) to decide`);
      if (pending) flags.push(`${pending} instruction(s) not yet read`);
      row.instructions = { unread: pending, refused_open: refused };
      const red = flags.some((f) => /missed dose|out of range|refused|Rating|not read/.test(f) && !/instruction\(s\) not yet read/.test(f));
      row.health = red ? 'RED' : flags.length ? 'AMBER' : 'GREEN';
      row.flags = flags;
      rows.push(row);
    }
    const rank = { RED: 0, AMBER: 1, GREEN: 2 } as Record<string, number>;
    rows.sort((a, b) => rank[a.health as string] - rank[b.health as string]);
    return {
      date: today,
      counts: { RED: rows.filter((r) => r.health === 'RED').length, AMBER: rows.filter((r) => r.health === 'AMBER').length, GREEN: rows.filter((r) => r.health === 'GREEN').length },
      items: rows,
    };
  }

  // ── Monthly report (PDF) ──────────────────────────────────────────────────

  async monthlyReport(user: AuthUser, placementId: string, month?: string): Promise<{ buffer: Buffer; filename: string }> {
    const ctx = await this.access.resolve(user, placementId);
    if (ctx.role === 'STAFF') throw new BadRequestException('The monthly report is for the family and the RM.');
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : istNow().date.slice(0, 7);
    const start = `${m}-01`;
    const end = addDays(dateStr(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1))), -1);
    const isCare = CARE_SERIES.includes(ctx.staff.series);
    const isCook = ctx.staff.series === StaffSeries.COOK;

    const care = isCare ? await this.care.history({ id: '', role: 'ADMIN' }, placementId, start, end > istNow().date ? istNow().date : end).catch(() => null) : null;
    const reports = isCare ? await this.prisma.dailyCareReport.count({ where: { placementId, reportDate: { gte: dbDate(start), lte: dbDate(end) } } }) : 0;
    const meals = isCook
      ? await this.prisma.mealLog.findMany({ where: { placementId, mealDate: { gte: dbDate(start), lte: dbDate(end) } }, include: { feedback: true } })
      : [];
    const ins = await this.prisma.clientInstruction.findMany({ where: { placementId, createdAt: { gte: new Date(`${start}T00:00:00+05:30`), lte: new Date(`${end}T23:59:59+05:30`) } }, select: { status: true } });

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const h = (t: string) => doc.moveDown(0.8).fontSize(13).fillColor('#111').text(t).moveDown(0.3).fontSize(10).fillColor('#333');
      const kv = (k: string, v: string | number | null) => doc.text(`${k}: ${v ?? '—'}`);

      doc.fontSize(18).fillColor('#E85D04').text('HomeGenny — Monthly Care Report');
      doc.fontSize(10).fillColor('#555').text(`${m} · generated ${istNow().date}`);
      h('Household');
      kv('Client', ctx.client.customerName);
      kv('Staff', `${ctx.staff.fullName} (${ctx.staff.series.replace(/_/g, ' ').toLowerCase()})`);
      kv('Placement status', ctx.placement.status);

      if (isCare) {
        h('Medicines & checks');
        kv('Medicine adherence', care?.medication_adherence_pct !== null && care?.medication_adherence_pct !== undefined ? `${care.medication_adherence_pct}%` : 'no doses due');
        kv('Missed doses', care?.missed_doses ?? 0);
        kv('Days with a checklist', care?.days.length ?? 0);
        kv('Daily reports filled', reports);
        const vit = care?.vitals ?? [];
        h(`Readings (${vit.length})`);
        if (!vit.length) doc.text('No readings recorded.');
        for (const v of vit.slice(0, 80)) {
          const val = v.value as Record<string, unknown> | null;
          const shown = val?.systolic ? `${val.systolic}/${val.diastolic} mmHg` : `${val?.value ?? ''} ${val?.unit ?? ''}`;
          doc.fillColor(v.out_of_range ? '#C1121F' : '#333').text(`${v.date} ${v.time}  ${v.title.replace(/^Check /, '')}: ${shown}${v.out_of_range ? '  (!) out of range' : ''}`);
        }
        if (vit.length > 80) doc.fillColor('#555').text(`…and ${vit.length - 80} more.`);
        doc.fillColor('#333');
      }

      if (isCook) {
        const rated = meals.filter((x) => x.feedback);
        const avg = rated.length ? Math.round((rated.reduce((a, x) => a + (x.feedback?.rating ?? 0), 0) / rated.length) * 10) / 10 : null;
        const top = new Map<string, number>();
        for (const x of meals) for (const d of (x.dishes as { name: string }[]) ?? []) top.set(d.name, (top.get(d.name) ?? 0) + 1);
        h('Kitchen');
        kv('Meals cooked', meals.length);
        kv('Meals rated', rated.length);
        kv('Average rating', avg !== null ? `${avg}/5` : '—');
        kv('Most cooked', [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`).join(', ') || '—');
      }

      h('Instructions');
      kv('Given', ins.length);
      kv('Done', ins.filter((x) => x.status === 'DONE').length);
      kv('Refused', ins.filter((x) => x.status === 'REFUSED').length);
      doc.moveDown(2).fontSize(8).fillColor('#888').text('This report contains health information. Share it only with people caring for the patient.');
      doc.end();
    });
    return { buffer, filename: `homegenny-care-report-${m}.pdf` };
  }
}

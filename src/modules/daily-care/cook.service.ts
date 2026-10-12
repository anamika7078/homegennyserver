import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FoodProfile, MealLog, MenuPlan, Prisma, StaffSeries } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';
import {
  ACTIVE_PLACEMENT,
  CareAccessService,
  PlacementCtx,
  addDays,
  assertLoggableDate,
  dateStr,
  dbDate,
  istNow,
  parseDate,
  stableJson,
} from './care-access.service';
import { CareFilesService } from './care-files.service';

/**
 * Phase D — the household's food profile, the week's menu, what the cook made,
 * and how the family liked it.
 *
 * The food profile belongs to the client, not the placement, so a new cook
 * inherits it. Menu rows are one per placement/date/meal: the client sets
 * them (PLANNED), or the cook proposes (SUGGESTED) and the client approves or
 * rejects. Ratings feed the cook's score and, when one complaint keeps coming
 * back, a suggestion to the client to change the profile — never a silent edit.
 */

export const MEALS = ['BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER'];
const DIETS = ['VEG', 'EGG', 'NON_VEG', 'JAIN', 'VEGAN'];
const LOW_NORMAL = ['LOW', 'NORMAL'];
export const FEEDBACK_TAGS = ['PERFECT', 'TOO_SPICY', 'LESS_SPICY', 'TOO_SALTY', 'LESS_SALT', 'OILY', 'UNDERCOOKED', 'OVERCOOKED', 'COLD', 'SMALL_PORTION'];
/** Same tag this many times in the last 14 days → suggest a profile change. */
const REPEAT_TAG_THRESHOLD = 3;
/** 7-day average under this → the RM is told. */
const LOW_RATING = 3;
/**
 * Words that clash with a health condition. Only a warning on the menu — a
 * family may well choose to have gulab jamun on a birthday.
 */
const HEALTH_CLASHES: Record<string, string[]> = {
  DIABETIC: ['sweet', 'halwa', 'kheer', 'gulab jamun', 'jalebi', 'ladoo', 'laddu', 'barfi', 'rasgulla', 'cake', 'sugar', 'mithai', 'payasam'],
  LOW_SODIUM: ['pickle', 'achar', 'papad', 'chips', 'namkeen'],
  LOW_FAT: ['fried', 'pakora', 'pakoda', 'puri', 'poori', 'bhatura', 'samosa', 'kachori', 'butter', 'malai'],
  NO_ONION_GARLIC: ['onion', 'garlic', 'pyaz', 'pyaaz', 'lehsun', 'lahsun'],
};

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const upperList = (v: unknown) =>
  [...new Set((Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim().toUpperCase().replace(/\s+/g, '_')).filter(Boolean))];
const textList = (v: unknown) => [...new Set((Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim()).filter(Boolean))];

function mealOf(v: unknown): string {
  const m = s(v).toUpperCase();
  if (!MEALS.includes(m)) throw new BadRequestException(`meal must be one of ${MEALS.join(', ')}.`);
  return m;
}

/** "2026-W42" or a date → the Monday..Sunday it covers (IST). */
function weekRange(week?: string): { start: string; end: string } {
  let anchor = istNow().date;
  if (week) {
    const m = /^(\d{4})-W(\d{2})$/.exec(week);
    if (m) {
      // ISO week: the week with Jan 4th is week 1.
      const jan4 = Date.UTC(Number(m[1]), 0, 4);
      const jan4Dow = (new Date(jan4).getUTCDay() + 6) % 7;
      anchor = new Date(jan4 - jan4Dow * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
    } else anchor = parseDate(week, 'week');
  }
  const dow = (new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(anchor, -dow);
  return { start, end: addDays(start, 6) };
}

@Injectable()
export class CookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CareAccessService,
    private readonly files: CareFilesService,
  ) {}

  // ── Food profile ──────────────────────────────────────────────────────────

  private profileFields(p: FoodProfile | null) {
    if (!p) return null;
    return {
      diet_type: p.dietType,
      allergies: p.allergies,
      spice_level: p.spiceLevel,
      salt: p.salt,
      oil: p.oil,
      health_conditions: p.healthConditions,
      cuisines: p.cuisines,
      dislikes: p.dislikes,
      family_size: p.familySize,
      notes: p.notes,
    };
  }

  profileDto(p: FoodProfile | null) {
    if (!p) return null;
    return { id: p.id, version: p.version, ...this.profileFields(p), changes: this.profileChanges(p), updated_at: p.updatedAt };
  }

  /** What differs from the version before, in words. */
  private profileChanges(p: FoodProfile): string[] {
    const prev = p.previous as Record<string, unknown> | null;
    if (!prev) return p.version === 1 ? ['New food profile'] : [];
    const cur = this.profileFields(p)!;
    const label: Record<string, string> = {
      diet_type: 'Diet', allergies: 'Allergies', spice_level: 'Spice level', salt: 'Salt', oil: 'Oil',
      health_conditions: 'Health', cuisines: 'Cuisines', dislikes: 'Dislikes', family_size: 'People', notes: 'Notes',
    };
    const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : '—') : v === null || v === undefined || v === '' ? '—' : String(v));
    return Object.keys(label)
      .filter((k) => stableJson(prev[k] ?? null) !== stableJson((cur as Record<string, unknown>)[k] ?? null))
      .map((k) => `${label[k]}: ${show(prev[k])} → ${show((cur as Record<string, unknown>)[k])}`);
  }

  async getProfileForClient(userId: string) {
    const customer = await this.prisma.financeCustomer.findFirst({ where: { userId }, select: { id: true } });
    if (!customer) throw new BadRequestException('No client account is linked to this login.');
    const p = await this.prisma.foodProfile.findUnique({ where: { clientId: customer.id } });
    return { profile: this.profileDto(p), feedback_suggestions: await this.suggestions(customer.id) };
  }

  async saveProfile(userId: string, body: Record<string, unknown>) {
    const customer = await this.prisma.financeCustomer.findFirst({ where: { userId }, select: { id: true } });
    if (!customer) throw new BadRequestException('No client account is linked to this login.');
    const diet = s(body.diet_type).toUpperCase();
    if (!DIETS.includes(diet)) throw new BadRequestException(`diet_type is required — one of ${DIETS.join(', ')}.`);
    const spice = body.spice_level === undefined || body.spice_level === null || body.spice_level === '' ? null : Number(body.spice_level);
    if (spice !== null && (!Number.isInteger(spice) || spice < 1 || spice > 5)) throw new BadRequestException('spice_level must be 1 (mild) to 5 (very spicy).');
    const salt = s(body.salt).toUpperCase() || null;
    const oil = s(body.oil).toUpperCase() || null;
    if (salt && !LOW_NORMAL.includes(salt)) throw new BadRequestException('salt must be LOW or NORMAL.');
    if (oil && !LOW_NORMAL.includes(oil)) throw new BadRequestException('oil must be LOW or NORMAL.');
    const family = body.family_size === undefined || body.family_size === '' || body.family_size === null ? null : Number(body.family_size);
    if (family !== null && (!Number.isInteger(family) || family < 1 || family > 50)) throw new BadRequestException('family_size must be a whole number.');

    const data = {
      dietType: diet,
      allergies: textList(body.allergies) as Prisma.InputJsonValue,
      spiceLevel: spice,
      salt,
      oil,
      healthConditions: upperList(body.health_conditions) as Prisma.InputJsonValue,
      cuisines: textList(body.cuisines) as Prisma.InputJsonValue,
      dislikes: s(body.dislikes) || null,
      familySize: family,
      notes: s(body.notes) || null,
    };
    const cur = await this.prisma.foodProfile.findUnique({ where: { clientId: customer.id } });
    let row: FoodProfile;
    if (!cur) {
      row = await this.prisma.foodProfile.create({ data: { ...data, clientId: customer.id, version: 1, updatedBy: userId } });
    } else {
      const before = this.profileFields(cur);
      const after = this.profileFields({ ...cur, ...data } as FoodProfile);
      if (stableJson(before) === stableJson(after)) return this.getProfileForClient(userId);
      row = await this.prisma.foodProfile.update({
        where: { id: cur.id },
        data: { ...data, version: cur.version + 1, previous: before as Prisma.InputJsonValue, updatedBy: userId, updatedAt: new Date() },
      });
    }
    // Every cook working for this household is told.
    const cooks = await this.activeCookUsers(customer.id);
    await this.access.notify(cooks, 'Food preferences updated', this.profileChanges(row).slice(0, 3).join(' · ') || 'Updated', 'FOOD_PROFILE_UPDATED', { food_profile_id: row.id, version: row.version });
    return this.getProfileForClient(userId);
  }

  private async activeCookUsers(clientId: string): Promise<string[]> {
    const ps = await this.prisma.placement.findMany({
      where: { clientId, status: { in: ACTIVE_PLACEMENT as never } },
      select: { staffId: true },
    });
    const staff = await this.prisma.staffApplicant.findMany({
      where: { id: { in: ps.map((p) => p.staffId) }, series: StaffSeries.COOK },
      select: { userId: true },
    });
    return staff.map((x) => x.userId).filter((x): x is string => !!x);
  }

  /** The cook (or RM) reads the household profile through the placement. */
  async getProfileForPlacement(user: AuthUser, placementId: string) {
    const ctx = await this.access.resolve(user, placementId);
    this.access.assertCook(ctx);
    const p = await this.prisma.foodProfile.findUnique({ where: { clientId: ctx.client.id } });
    return { placement_id: placementId, client: { id: ctx.client.id, name: ctx.client.customerName }, profile: this.profileDto(p) };
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  private dishList(v: unknown, field: string): { name: string; notes?: string }[] {
    const arr = Array.isArray(v) ? v : [];
    const out = arr
      .map((d) => (typeof d === 'string' ? { name: d.trim() } : { name: s((d as Record<string, unknown>).name), notes: s((d as Record<string, unknown>).notes) || undefined }))
      .filter((d) => d.name);
    if (!out.length) throw new BadRequestException(`${field} needs at least one dish.`);
    return out;
  }

  menuDto(m: MenuPlan, healthConditions: string[] = []) {
    const names = ((m.dishes as { name: string }[]) ?? []).map((d) => d.name.toLowerCase()).join(' ');
    const warnings: string[] = [];
    for (const hc of healthConditions) {
      const hits = (HEALTH_CLASHES[hc] ?? []).filter((w) => names.includes(w));
      if (hits.length) warnings.push(`${hc.replace(/_/g, ' ').toLowerCase()}: ${hits.join(', ')}`);
    }
    const prev = m.previous as { dishes?: { name: string }[]; special_instruction?: string } | null;
    const changes: string[] = [];
    if (prev) {
      const a = (prev.dishes ?? []).map((d) => d.name).join(', ');
      const b = ((m.dishes as { name: string }[]) ?? []).map((d) => d.name).join(', ');
      if (a !== b) changes.push(`${a || '—'} → ${b}`);
      if ((prev.special_instruction ?? '') !== (m.specialInstruction ?? '')) changes.push(`Instruction: ${m.specialInstruction ?? '—'}`);
    }
    return {
      id: m.id,
      date: dateStr(m.menuDate),
      meal: m.meal,
      dishes: m.dishes,
      special_instruction: m.specialInstruction,
      servings: m.servings,
      status: m.status,
      version: m.version,
      reject_reason: m.rejectReason,
      suggested_by_cook: m.createdByRole === 'STAFF',
      changes,
      health_warnings: warnings,
      updated_at: m.updatedAt,
    };
  }

  async getMenu(user: AuthUser, placementId: string, week?: string) {
    const ctx = await this.access.resolve(user, placementId);
    this.access.assertCook(ctx);
    const { start, end } = weekRange(week);
    const [rows, profile] = await Promise.all([
      this.prisma.menuPlan.findMany({
        where: { placementId, menuDate: { gte: dbDate(start), lte: dbDate(end) } },
        orderBy: [{ menuDate: 'asc' }, { meal: 'asc' }],
      }),
      this.prisma.foodProfile.findUnique({ where: { clientId: ctx.client.id } }),
    ]);
    const hc = (profile?.healthConditions as string[]) ?? [];
    const order = (m: string) => MEALS.indexOf(m);
    return {
      placement_id: placementId,
      week_start: start,
      week_end: end,
      items: rows.sort((a, b) => a.menuDate.getTime() - b.menuDate.getTime() || order(a.meal) - order(b.meal)).map((m) => this.menuDto(m, hc)),
    };
  }

  /**
   * The client sets the menu for any number of date/meal slots at once.
   * `items: [{ date, meal, dishes: [..], special_instruction?, servings? }]`;
   * an item with `dishes: []` clears that slot.
   */
  async saveMenu(user: AuthUser, placementId: string, body: Record<string, unknown>) {
    const ctx = await this.access.resolve(user, placementId, { write: true });
    if (ctx.role !== 'CLIENT') throw new BadRequestException('Only the client sets the menu — the cook can suggest one.');
    this.access.assertCook(ctx);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    if (!items.length) throw new BadRequestException('items is required — [{ date, meal, dishes }].');
    const today = istNow().date;
    const touched: string[] = [];
    for (const [i, it] of items.entries()) {
      const date = parseDate(it.date, `items[${i}].date`);
      if (date < today) throw new BadRequestException(`items[${i}]: ${date} is in the past.`);
      const meal = mealOf(it.meal);
      const key = { placementId_menuDate_meal: { placementId, menuDate: dbDate(date), meal } };
      if (Array.isArray(it.dishes) && !it.dishes.length) {
        await this.prisma.menuPlan.deleteMany({ where: { placementId, menuDate: dbDate(date), meal } });
        touched.push(`${date} ${meal}: cleared`);
        continue;
      }
      const dishes = this.dishList(it.dishes, `items[${i}].dishes`);
      const servings = it.servings === undefined || it.servings === '' ? null : Number(it.servings) || null;
      const cur = await this.prisma.menuPlan.findUnique({ where: key });
      const data = {
        dishes: dishes as Prisma.InputJsonValue,
        specialInstruction: s(it.special_instruction) || null,
        servings,
        status: 'PLANNED',
        rejectReason: null,
        createdBy: user.id,
        createdByRole: 'CLIENT',
        updatedAt: new Date(),
      };
      if (cur) {
        if (stableJson(cur.dishes) === stableJson(dishes) && (cur.specialInstruction ?? null) === data.specialInstruction && cur.servings === servings && cur.status === 'PLANNED') continue;
        await this.prisma.menuPlan.update({
          where: { id: cur.id },
          data: { ...data, version: cur.version + 1, previous: { dishes: cur.dishes, special_instruction: cur.specialInstruction } as Prisma.InputJsonValue },
        });
      } else {
        await this.prisma.menuPlan.create({ data: { ...data, placementId, menuDate: dbDate(date), meal } });
      }
      touched.push(`${date} ${meal.toLowerCase()}: ${dishes.map((d) => d.name).join(', ')}`);
    }
    if (touched.length) {
      await this.access.notify([ctx.staff.userId], 'Menu updated by the family', touched.slice(0, 3).join(' · ') + (touched.length > 3 ? ` · +${touched.length - 3} more` : ''), 'MENU_UPDATED', { placement_id: placementId });
    }
    return this.getMenu(user, placementId, body.week ? String(body.week) : (items[0]?.date as string));
  }

  /** The cook proposes; nothing on the client's own PLANNED/APPROVED slots is overwritten. */
  async suggestMenu(user: AuthUser, body: Record<string, unknown>) {
    const placementId = s(body.placement_id);
    if (!placementId) throw new BadRequestException('placement_id is required.');
    const ctx = await this.access.resolve(user, placementId, { write: true });
    if (ctx.role !== 'STAFF') throw new BadRequestException('Only the cook suggests a menu.');
    this.access.assertCook(ctx);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    if (!items.length) throw new BadRequestException('items is required — [{ date, meal, dishes }].');
    const today = istNow().date;
    let n = 0;
    for (const [i, it] of items.entries()) {
      const date = parseDate(it.date, `items[${i}].date`);
      if (date < today) throw new BadRequestException(`items[${i}]: ${date} is in the past.`);
      const meal = mealOf(it.meal);
      const dishes = this.dishList(it.dishes, `items[${i}].dishes`);
      const cur = await this.prisma.menuPlan.findUnique({ where: { placementId_menuDate_meal: { placementId, menuDate: dbDate(date), meal } } });
      if (cur && ['PLANNED', 'APPROVED'].includes(cur.status)) {
        throw new BadRequestException(`${date} ${meal.toLowerCase()} is already set by the family.`);
      }
      const data = { dishes: dishes as Prisma.InputJsonValue, specialInstruction: s(it.notes) || null, status: 'SUGGESTED', rejectReason: null, createdBy: user.id, createdByRole: 'STAFF', updatedAt: new Date() };
      if (cur) await this.prisma.menuPlan.update({ where: { id: cur.id }, data: { ...data, version: cur.version + 1 } });
      else await this.prisma.menuPlan.create({ data: { ...data, placementId, menuDate: dbDate(date), meal } });
      n++;
    }
    await this.access.notify([ctx.client.userId], 'Your cook suggested a menu', `${n} meal${n === 1 ? '' : 's'} waiting for your OK.`, 'MENU_SUGGESTED', { placement_id: placementId });
    return this.getMenu(user, placementId, String(items[0].date));
  }

  async decideSuggestion(user: AuthUser, menuId: string, approve: boolean, reason?: string) {
    const m = await this.prisma.menuPlan.findUnique({ where: { id: menuId } });
    if (!m) throw new NotFoundException('Menu item not found.');
    const ctx = await this.access.resolve(user, m.placementId, { write: true });
    if (ctx.role !== 'CLIENT') throw new BadRequestException('Only the client approves a suggestion.');
    if (m.status !== 'SUGGESTED') throw new BadRequestException(`This menu item is ${m.status}, not a suggestion.`);
    if (!approve && !s(reason)) throw new BadRequestException('Say why — the cook will see it.');
    const row = await this.prisma.menuPlan.update({
      where: { id: menuId },
      data: { status: approve ? 'APPROVED' : 'REJECTED', rejectReason: approve ? null : s(reason), version: m.version + 1, updatedAt: new Date() },
    });
    await this.access.notify(
      [ctx.staff.userId],
      approve ? 'Menu approved' : 'Menu suggestion declined',
      `${dateStr(m.menuDate)} ${m.meal.toLowerCase()}${approve ? '' : `: ${s(reason)}`}`,
      approve ? 'MENU_APPROVED' : 'MENU_REJECTED',
      { placement_id: m.placementId, menu_id: m.id },
    );
    return this.menuDto(row);
  }

  // ── Meal log + feedback ───────────────────────────────────────────────────

  private mealDto(l: MealLog & { feedback?: { rating: number; tags: Prisma.JsonValue; comment: string | null; createdAt: Date } | null }) {
    return {
      id: l.id,
      date: dateStr(l.mealDate),
      meal: l.meal,
      menu_plan_id: l.menuPlanId,
      dishes: l.dishes,
      servings: l.servings,
      cooked_at: l.cookedAt,
      notes: l.notes,
      feedback: l.feedback ? { rating: l.feedback.rating, tags: l.feedback.tags, comment: l.feedback.comment, at: l.feedback.createdAt } : null,
    };
  }

  /**
   * What the cook made: `{ placement_id, date?, meal, dishes: [{ name, spice_level?, photo_file_id? }], servings?, notes? }`.
   * Photos are optional (uploaded first through POST /care-files).
   */
  async logMeal(user: AuthUser, body: Record<string, unknown>) {
    const placementId = s(body.placement_id);
    if (!placementId) throw new BadRequestException('placement_id is required.');
    const ctx = await this.access.resolve(user, placementId, { write: true });
    if (ctx.role !== 'STAFF') throw new BadRequestException('Only the cook logs a meal.');
    this.access.assertCook(ctx);
    const date = body.date ? parseDate(body.date) : istNow().date;
    assertLoggableDate(date);
    const meal = mealOf(body.meal);
    const raw = Array.isArray(body.dishes) ? (body.dishes as Record<string, unknown>[]) : [];
    const dishes: { name: string; spice_level?: number; photo_file_id?: string }[] = [];
    for (const [i, d] of raw.entries()) {
      const name = typeof d === 'string' ? String(d).trim() : s(d.name);
      if (!name) continue;
      const spice = typeof d === 'object' && d.spice_level !== undefined && d.spice_level !== '' ? Number(d.spice_level) : undefined;
      if (spice !== undefined && (!Number.isInteger(spice) || spice < 1 || spice > 5)) throw new BadRequestException(`dishes[${i}].spice_level must be 1–5.`);
      const [photo] = typeof d === 'object' && d.photo_file_id ? await this.files.assertOwned(placementId, d.photo_file_id, 'PHOTO') : [undefined];
      dishes.push({ name, ...(spice ? { spice_level: spice } : {}), ...(photo ? { photo_file_id: photo } : {}) });
    }
    if (!dishes.length) throw new BadRequestException('dishes needs at least one dish.');
    const plan = await this.prisma.menuPlan.findUnique({ where: { placementId_menuDate_meal: { placementId, menuDate: dbDate(date), meal } } });
    const data = {
      staffId: ctx.staff.id,
      menuPlanId: plan?.id ?? null,
      dishes: dishes as Prisma.InputJsonValue,
      servings: body.servings === undefined || body.servings === '' ? null : Number(body.servings) || null,
      notes: s(body.notes) || null,
      cookedAt: new Date(),
      updatedAt: new Date(),
    };
    const row = await this.prisma.mealLog.upsert({
      where: { placementId_mealDate_meal: { placementId, mealDate: dbDate(date), meal } },
      update: data,
      create: { ...data, placementId, mealDate: dbDate(date), meal },
      include: { feedback: true },
    });
    await this.access.notify([ctx.client.userId], `${meal.charAt(0) + meal.slice(1).toLowerCase()} is ready`, dishes.map((d) => d.name).join(', '), 'MEAL_LOGGED', { placement_id: placementId, meal_log_id: row.id });
    return this.mealDto(row);
  }

  async listMeals(user: AuthUser, placementId: string, from?: string, to?: string) {
    const ctx = await this.access.resolve(user, placementId);
    this.access.assertCook(ctx);
    const end = to ? parseDate(to, 'to') : istNow().date;
    const start = from ? parseDate(from, 'from') : end;
    if (start > end) throw new BadRequestException('from is after to.');
    const rows = await this.prisma.mealLog.findMany({
      where: { placementId, mealDate: { gte: dbDate(start), lte: dbDate(end) } },
      orderBy: [{ mealDate: 'desc' }, { cookedAt: 'desc' }],
      include: { feedback: true },
    });
    return { placement_id: placementId, from: start, to: end, items: rows.map((r) => this.mealDto(r)), rating: await this.ratingStats(placementId) };
  }

  async feedback(user: AuthUser, mealLogId: string, body: Record<string, unknown>) {
    const log = await this.prisma.mealLog.findUnique({ where: { id: mealLogId } });
    if (!log) throw new NotFoundException('Meal not found.');
    const ctx = await this.access.resolve(user, log.placementId);
    if (ctx.role !== 'CLIENT') throw new BadRequestException('Only the client rates a meal.');
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException('rating must be 1 to 5.');
    const tags = upperList(body.tags);
    const bad = tags.filter((t) => !FEEDBACK_TAGS.includes(t));
    if (bad.length) throw new BadRequestException(`Unknown tag(s): ${bad.join(', ')}. Use: ${FEEDBACK_TAGS.join(', ')}.`);
    const data = { rating, tags: tags as Prisma.InputJsonValue, comment: s(body.comment) || null, createdBy: user.id, updatedAt: new Date() };
    await this.prisma.mealFeedback.upsert({ where: { mealLogId }, update: data, create: { ...data, mealLogId } });
    await this.access.notify([ctx.staff.userId], `Family rated your ${log.meal.toLowerCase()} ${rating}/5`, [tags.map((t) => t.replace(/_/g, ' ').toLowerCase()).join(', '), s(body.comment)].filter(Boolean).join(' — ') || '—', 'MEAL_FEEDBACK', { placement_id: log.placementId, meal_log_id: log.id });

    const stats = await this.ratingStats(log.placementId);
    if (stats.avg_7d !== null && stats.avg_7d < LOW_RATING && stats.count_7d >= 3) {
      const already = await this.prisma.notification.findFirst({
        where: { template: 'COOK_LOW_RATING', createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) }, payload: { path: ['placement_id'], equals: log.placementId } },
      });
      if (!already) {
        await this.access.notify([await this.access.rmOf(ctx)], 'Cook rating is low', `${ctx.staff.fullName} at ${ctx.client.customerName}: ${stats.avg_7d}/5 over the last 7 days.`, 'COOK_LOW_RATING', { placement_id: log.placementId });
      }
    }
    const full = await this.prisma.mealLog.findUniqueOrThrow({ where: { id: mealLogId }, include: { feedback: true } });
    return { meal: this.mealDto(full), rating: stats, suggestions: await this.suggestions(ctx.client.id) };
  }

  async ratingStats(placementId: string) {
    const since7 = new Date(Date.now() - 7 * 86_400_000);
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.prisma.mealFeedback.findMany({
      where: { mealLog: { placementId }, createdAt: { gt: since30 } },
      select: { rating: true, createdAt: true },
    });
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const r7 = rows.filter((r) => r.createdAt > since7).map((r) => r.rating);
    return { avg_7d: avg(r7), count_7d: r7.length, avg_30d: avg(rows.map((r) => r.rating)), count_30d: rows.length };
  }

  /** "Too spicy" three times in two weeks → offer to lower the profile's spice level. */
  private async suggestions(clientId: string) {
    const rows = await this.prisma.mealFeedback.findMany({
      where: { createdAt: { gt: new Date(Date.now() - 14 * 86_400_000) }, mealLog: { placement: { clientId } } },
      select: { tags: true },
    });
    const count = new Map<string, number>();
    for (const r of rows) for (const t of (r.tags as string[]) ?? []) count.set(t, (count.get(t) ?? 0) + 1);
    const profile = await this.prisma.foodProfile.findUnique({ where: { clientId } });
    const out: { tag: string; times: number; suggestion: string }[] = [];
    const add = (tag: string, suggestion: string) => {
      const n = count.get(tag) ?? 0;
      if (n >= REPEAT_TAG_THRESHOLD) out.push({ tag, times: n, suggestion });
    };
    const lvl = profile?.spiceLevel ?? null;
    if (lvl && lvl > 1) add('TOO_SPICY', `Lower spice level from ${lvl} to ${lvl - 1}?`);
    if (lvl && lvl < 5) add('LESS_SPICY', `Raise spice level from ${lvl} to ${lvl + 1}?`);
    if (profile?.salt !== 'LOW') add('TOO_SALTY', 'Set salt to LOW?');
    if (profile?.oil !== 'LOW') add('OILY', 'Set oil to LOW?');
    return out;
  }

  // ── Cook's day ────────────────────────────────────────────────────────────

  async cookToday(user: AuthUser) {
    const staff = await this.access.staffForUser(user.id);
    const today = istNow().date;
    if (staff.series !== StaffSeries.COOK) return { date: today, placements: [] };
    const placements = await this.access.activePlacementsForStaff(staff.id);
    const out: Record<string, unknown>[] = [];
    for (const { placement, client } of placements) {
      const [menu, logs, profile] = await Promise.all([
        this.prisma.menuPlan.findMany({ where: { placementId: placement.id, menuDate: dbDate(today) } }),
        this.prisma.mealLog.findMany({ where: { placementId: placement.id, mealDate: dbDate(today) }, include: { feedback: true } }),
        this.prisma.foodProfile.findUnique({ where: { clientId: placement.clientId } }),
      ]);
      const hc = (profile?.healthConditions as string[]) ?? [];
      out.push({
        placement_id: placement.id,
        client: { id: placement.clientId, name: client?.customerName ?? null, address: client?.address ?? null },
        food_profile: this.profileDto(profile),
        meals: MEALS.map((meal) => {
          const m = menu.find((x) => x.meal === meal);
          const l = logs.find((x) => x.meal === meal);
          return { meal, menu: m ? this.menuDto(m, hc) : null, log: l ? this.mealDto(l) : null };
        }).filter((x) => x.menu || x.log),
        rating: await this.ratingStats(placement.id),
      });
    }
    return { date: today, placements: out };
  }
}

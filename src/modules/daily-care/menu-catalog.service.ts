import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Dish, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/guards/branch-scope.util';

/**
 * The dish list behind the client's menu dropdown, and each client's own
 * dishes — docs/MENU_TRACKING_REQUEST_CHANGES_PLAN.md §1.
 *
 * Common dishes (client_id NULL) come from scratch/_dishes_seed.js and have no
 * admin screen. A client who can't find a dish adds it themselves; it is theirs
 * alone. "The same dish" means the same name, ignoring case and extra spaces.
 */

export const DISH_CATEGORIES = ['BREAKFAST', 'DAL', 'SABZI', 'ROTI_PARATHA', 'RICE', 'SNACK', 'SALAD', 'SWEET', 'DRINK', 'OTHER'];
export const DISH_DIETS = ['VEG', 'EGG', 'NON_VEG'];
export const DISH_REGIONS = ['NORTH_INDIAN', 'PUNJABI', 'SOUTH_INDIAN', 'GUJARATI', 'MAHARASHTRIAN', 'BENGALI', 'RAJASTHANI', 'OTHER'];
const MEALS = ['BREAKFAST', 'LUNCH', 'SNACKS', 'DINNER'];

export const dishKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Which dishes a food-profile diet allows. NON_VEG (or no profile) allows all. */
export function dietsAllowed(dietType: string | null | undefined): { diets: string[]; jainOnly: boolean } {
  switch ((dietType ?? '').toUpperCase()) {
    case 'VEG':
    case 'VEGAN':
      return { diets: ['VEG'], jainOnly: false };
    case 'JAIN':
      return { diets: ['VEG'], jainOnly: true };
    case 'EGG':
      return { diets: ['VEG', 'EGG'], jainOnly: false };
    default:
      return { diets: DISH_DIETS, jainOnly: false };
  }
}

/** Free-text cuisines on the food profile ("North Indian", "Gujarati") → region codes. */
export function regionsFromCuisines(cuisines: unknown): string[] {
  const text = (Array.isArray(cuisines) ? cuisines : []).join(' ').toLowerCase();
  const map: [RegExp, string][] = [
    [/north/, 'NORTH_INDIAN'], [/punjab/, 'PUNJABI'], [/south|tamil|kerala|karnataka|andhra|telugu/, 'SOUTH_INDIAN'],
    [/gujarat/, 'GUJARATI'], [/maharash|marathi/, 'MAHARASHTRIAN'], [/bengal/, 'BENGALI'], [/rajasth|marwar/, 'RAJASTHANI'],
  ];
  return map.filter(([re]) => re.test(text)).map(([, r]) => r);
}

/** The meals a dish suits when its owner doesn't say. */
function defaultMeals(category: string): string[] {
  if (category === 'BREAKFAST') return ['BREAKFAST'];
  if (category === 'SNACK') return ['SNACKS'];
  if (category === 'DRINK') return ['BREAKFAST', 'SNACKS'];
  return ['LUNCH', 'DINNER'];
}

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());

@Injectable()
export class MenuCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  dishDto(d: Dish) {
    return {
      id: d.id,
      name: d.name,
      category: d.category,
      diet: d.diet,
      jain_ok: d.jainOk,
      region: d.region,
      meals: d.meals,
      own: !!d.clientId,
    };
  }

  private async customerFor(user: AuthUser) {
    if (user.role !== 'CLIENT') return null;
    const c = await this.prisma.financeCustomer.findFirst({ where: { userId: user.id }, select: { id: true } });
    if (!c) throw new BadRequestException('No client account is linked to this login.');
    return c;
  }

  /**
   * Search for the dropdown. For a client: the common list plus their own
   * dishes, limited by their food profile's diet, their regions first, and
   * dishes for the asked meal first. Others see the common list.
   */
  async search(user: AuthUser, q: { q?: string; meal?: string; category?: string; diet?: string; region?: string; limit?: string }) {
    const customer = await this.customerFor(user);
    const profile = customer ? await this.prisma.foodProfile.findUnique({ where: { clientId: customer.id } }) : null;
    const allowed = dietsAllowed(profile?.dietType);
    const myRegions = regionsFromCuisines(profile?.cuisines);

    const meal = s(q.meal).toUpperCase();
    if (meal && !MEALS.includes(meal)) throw new BadRequestException(`meal must be one of ${MEALS.join(', ')}.`);
    const category = s(q.category).toUpperCase();
    if (category && !DISH_CATEGORIES.includes(category)) throw new BadRequestException(`category must be one of ${DISH_CATEGORIES.join(', ')}.`);
    const askedDiet = s(q.diet).toUpperCase();
    if (askedDiet && !DISH_DIETS.includes(askedDiet)) throw new BadRequestException(`diet must be one of ${DISH_DIETS.join(', ')}.`);
    const region = s(q.region).toUpperCase();
    if (region && !DISH_REGIONS.includes(region)) throw new BadRequestException(`region must be one of ${DISH_REGIONS.join(', ')}.`);
    const text = dishKey(s(q.q));
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);

    // The profile's diet is a hard limit; an asked diet can only narrow it.
    const diets = askedDiet ? allowed.diets.filter((d) => d === askedDiet) : allowed.diets;
    const where: Prisma.DishWhereInput = {
      active: true,
      OR: [{ clientId: null }, ...(customer ? [{ clientId: customer.id }] : [])],
      diet: { in: diets },
      ...(allowed.jainOnly ? { jainOk: true } : {}),
      ...(category ? { category } : {}),
      ...(region ? { region } : {}),
      ...(text ? { nameKey: { contains: text } } : {}),
    };
    const rows = await this.prisma.dish.findMany({ where, take: 500 });

    const score = (d: Dish) =>
      (text && d.nameKey.startsWith(text) ? 8 : 0) +
      (meal && d.meals.includes(meal) ? 4 : 0) +
      (myRegions.includes(d.region) ? 2 : 0) +
      (d.clientId ? 1 : 0);
    rows.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    const exact = text ? rows.some((d) => d.nameKey === text) : true;
    return {
      items: rows.slice(0, limit).map((d) => this.dishDto(d)),
      total: rows.length,
      filtered_by: { diet: diets, jain_only: allowed.jainOnly, regions_first: myRegions, meal: meal || null },
      // Nothing with exactly this name → the app offers "+ Add '<q>' as my dish".
      can_add: !!text && !exact,
    };
  }

  /** "+ Add as my dish". The same name already on the list (or theirs) is returned instead. */
  async addOwn(userId: string, body: Record<string, unknown>) {
    const customer = await this.customerFor({ id: userId, role: 'CLIENT' });
    const name = s(body.name).replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120) throw new BadRequestException('name must be 2 to 120 characters.');
    const category = (s(body.category) || 'OTHER').toUpperCase();
    if (!DISH_CATEGORIES.includes(category)) throw new BadRequestException(`category must be one of ${DISH_CATEGORIES.join(', ')}.`);
    const diet = s(body.diet).toUpperCase();
    if (!DISH_DIETS.includes(diet)) throw new BadRequestException(`diet is required — one of ${DISH_DIETS.join(', ')}.`);
    const meals = (Array.isArray(body.meals) ? body.meals : []).map((m) => String(m).toUpperCase());
    if (meals.some((m) => !MEALS.includes(m))) throw new BadRequestException(`meals must be any of ${MEALS.join(', ')}.`);

    const key = dishKey(name);
    const existing = await this.prisma.dish.findFirst({
      where: { nameKey: key, active: true, OR: [{ clientId: null }, { clientId: customer!.id }] },
      orderBy: { clientId: { sort: 'asc', nulls: 'first' } },
    });
    if (existing) return { dish: this.dishDto(existing), existing: true };
    const row = await this.prisma.dish.create({
      data: {
        clientId: customer!.id,
        name,
        nameKey: key,
        category,
        diet,
        jainOk: false,
        region: 'OTHER',
        meals: meals.length ? meals : defaultMeals(category),
        createdBy: userId,
      },
    });
    return { dish: this.dishDto(row), existing: false };
  }

  async listOwn(userId: string) {
    const customer = await this.customerFor({ id: userId, role: 'CLIENT' });
    const rows = await this.prisma.dish.findMany({ where: { clientId: customer!.id, active: true }, orderBy: { name: 'asc' } });
    return { items: rows.map((d) => this.dishDto(d)) };
  }

  /** Removes it from the dropdown. Menus that already use it keep the name. */
  async removeOwn(userId: string, id: string) {
    const customer = await this.customerFor({ id: userId, role: 'CLIENT' });
    const d = await this.prisma.dish.findFirst({ where: { id, clientId: customer!.id, active: true } });
    if (!d) throw new NotFoundException('That is not one of your dishes.');
    await this.prisma.dish.update({ where: { id }, data: { active: false } });
    return { id, removed: true };
  }

  /**
   * Dishes for one menu slot: picked from the list (`dish_ids`) and/or typed
   * (`dishes`, as names or { name, notes }). A typed name that matches a list
   * dish takes that dish's diet, so the veg/non-veg warning still works.
   */
  async resolveSlotDishes(clientId: string, it: Record<string, unknown>, field: string) {
    const ids = [...new Set((Array.isArray(it.dish_ids) ? it.dish_ids : []).map(String).filter(Boolean))];
    const picked = ids.length
      ? await this.prisma.dish.findMany({ where: { id: { in: ids }, OR: [{ clientId: null }, { clientId }] } })
      : [];
    const unknown = ids.filter((id) => !picked.some((d) => d.id === id));
    if (unknown.length) throw new BadRequestException(`${field}: unknown dish id(s): ${unknown.join(', ')}`);

    const typed = (Array.isArray(it.dishes) ? it.dishes : [])
      .map((d) =>
        typeof d === 'string'
          ? { name: d.trim() }
          : { name: s((d as Record<string, unknown>).name), notes: s((d as Record<string, unknown>).notes) || undefined },
      )
      .filter((d) => d.name);

    const out: { name: string; notes?: string; dish_id?: string; diet?: string; jain_ok?: boolean; category?: string }[] = [];
    for (const id of ids) {
      const d = picked.find((x) => x.id === id)!;
      out.push({ name: d.name, dish_id: d.id, diet: d.diet, jain_ok: d.jainOk, category: d.category });
    }
    const known = typed.length
      ? await this.prisma.dish.findMany({
          where: { nameKey: { in: typed.map((t) => dishKey(t.name)) }, OR: [{ clientId: null }, { clientId }] },
        })
      : [];
    for (const t of typed) {
      if (out.some((o) => dishKey(o.name) === dishKey(t.name))) continue;
      const k = known.find((d) => d.nameKey === dishKey(t.name));
      out.push(k ? { ...t, dish_id: k.id, diet: k.diet, jain_ok: k.jainOk, category: k.category } : t);
    }
    return { dishes: out, dishIds: out.map((d) => d.dish_id).filter((x): x is string => !!x) };
  }
}

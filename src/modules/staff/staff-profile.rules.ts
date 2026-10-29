import { BadRequestException } from '@nestjs/common';
import { StaffApplicant, StaffSeries } from '@prisma/client';
import { BRANCH_AREA_CONFIG } from '../rm/branch-areas.config';
import { mapSeriesFromShort } from '../../common/mappers/staff.mapper';
import { assertSeriesActive } from '../../common/config/active-series';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The staff profile — S1 — as one set of rules, used by the staff app
 * (PUT /staff/profile, POST /staff/profile/submit) and the RM's "Complete S1"
 * alike. docs/REGISTRATION_ONBOARDING_PLAN.md §A4.
 */

/** Every field S1 needs before the staff member can move to S2. */
export const STAFF_PROFILE_REQUIRED = [
  'full_name', 'date_of_birth', 'gender', 'series', 'address', 'city', 'pincode', 'emergency_contact',
] as const;

/** Fixed once S2 starts: S2 checks them against Aadhaar. Changing them later goes through the RM. */
export const STAFF_LOCKED_AFTER_S1 = ['full_name', 'date_of_birth', 'gender', 'series'] as const;

export const MIN_AGE = 18;
export const MAX_AGE = 65;
export const OTHER_CITY = 'Other';

export interface ServiceableCity {
  city: string;
  branch_id: string;
  areas: string[];
  /** Other spellings that mean the same city (matched case-insensitively). */
  aliases: string[];
}

/**
 * The cities HomeGenny works in, one per branch. Branches in
 * branch-areas.config take its first city as their name ("Delhi NCR") and the
 * rest as aliases ("New Delhi"), with their areas; a branch added since (from
 * the admin panel) is listed under its own city. Pass the active branches to
 * leave out closed ones; without them, the config alone.
 */
export function serviceableCities(activeBranches?: { id: string; city: string }[]): ServiceableCity[] {
  const activeIds = activeBranches ? new Set(activeBranches.map((b) => b.id)) : null;
  const byBranch = new Map<string, ServiceableCity>();
  for (const a of BRANCH_AREA_CONFIG) {
    if (activeIds && !activeIds.has(a.branch_id)) continue;
    let c = byBranch.get(a.branch_id);
    if (!c) {
      c = { city: a.city, branch_id: a.branch_id, areas: [], aliases: [] };
      byBranch.set(a.branch_id, c);
    }
    if (a.city !== c.city && !c.aliases.includes(a.city)) c.aliases.push(a.city);
    if (!c.areas.includes(a.area)) c.areas.push(a.area);
  }
  // Common ways people write the Delhi region.
  const delhi = [...byBranch.values()].find((c) => /delhi/i.test(c.city));
  if (delhi) for (const x of ['Delhi', 'Gurgaon', 'Gurugram', 'Noida', 'Faridabad', 'Ghaziabad']) if (!delhi.aliases.includes(x)) delhi.aliases.push(x);
  for (const b of activeBranches ?? []) {
    if (!byBranch.has(b.id) && b.city?.trim()) byBranch.set(b.id, { city: b.city.trim(), branch_id: b.id, areas: [], aliases: [] });
  }
  return [...byBranch.values()];
}

/** "new delhi" → { city: "Delhi NCR", branch_id }; "Other" → { city: "Other", branch_id: null }; unknown → null. */
export function resolveCity(raw: string, cities: ServiceableCity[]): { city: string; branch_id: string | null } | null {
  const v = raw.trim().toLowerCase();
  if (v === OTHER_CITY.toLowerCase()) return { city: OTHER_CITY, branch_id: null };
  for (const c of cities) {
    if (c.city.toLowerCase() === v || c.aliases.some((a) => a.toLowerCase() === v)) return { city: c.city, branch_id: c.branch_id };
  }
  return null;
}

/** Full years between a YYYY-MM-DD birth date and today (IST). */
export function ageOn(dob: string, today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)): number {
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

const digits10 = (v: string) => {
  const d = v.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
};

/** What the staff app / RM may send. Every field optional here; required-ness is checked separately. */
export interface StaffProfilePatch {
  fullName?: string;
  dateOfBirth?: Date;
  gender?: string;
  series?: StaffSeries;
  address?: string;
  city?: string;
  branchId?: string | null;
  area?: string;
  pincode?: string;
  emergencyContactName?: string;
  emergencyContactMobile?: string;
  languages?: string[];
  alternatePhone?: string;
  email?: string;
  experienceYears?: number;
  /** Form XVI muster roll column "Father's/Husband's Name". Optional. */
  fatherOrHusbandName?: string;
}

/**
 * Checks each field that was sent and returns it in stored form. Blank means
 * "not sent". `ownMobile` stops the staff naming themselves as their
 * emergency contact.
 */
export function parseStaffProfile(
  body: Record<string, unknown>,
  ctx: { ownMobile: string; cities: ServiceableCity[] },
): StaffProfilePatch {
  const str = (k: string) => {
    const v = body[k];
    if (v === undefined || v === null) return undefined;
    const t = String(v).trim();
    return t === '' ? undefined : t;
  };
  const out: StaffProfilePatch = {};

  const name = str('full_name');
  if (name !== undefined) {
    if (name.length < 2 || name.length > 200) throw new BadRequestException('full_name must be 2–200 characters.');
    out.fullName = name.replace(/\s+/g, ' ');
  }
  const dob = str('date_of_birth');
  if (dob !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) {
      throw new BadRequestException('date_of_birth must be YYYY-MM-DD.');
    }
    const age = ageOn(dob);
    if (age < MIN_AGE || age > MAX_AGE) {
      throw new BadRequestException(`Age must be between ${MIN_AGE} and ${MAX_AGE} (date_of_birth ${dob} is ${age}).`);
    }
    // UTC midnight — a @db.Date column stores the day meant (this server runs IST).
    out.dateOfBirth = new Date(`${dob}T00:00:00.000Z`);
  }
  const gender = str('gender')?.toUpperCase();
  if (gender !== undefined) {
    if (!['MALE', 'FEMALE', 'OTHER'].includes(gender)) throw new BadRequestException('gender must be MALE, FEMALE or OTHER.');
    out.gender = gender;
  }
  const series = str('series');
  if (series !== undefined) {
    out.series = mapSeriesFromShort(series);
    assertSeriesActive(out.series);
  }
  const address = str('address');
  if (address !== undefined) {
    if (address.length < 5 || address.length > 2000) throw new BadRequestException('address must be 5–2000 characters.');
    out.address = address;
  }
  const city = str('city');
  if (city !== undefined) {
    const c = resolveCity(city, ctx.cities);
    if (!c) {
      throw new BadRequestException(
        `city must be one of ${[...ctx.cities.map((x) => x.city), OTHER_CITY].join(', ')} (GET /meta/cities).`,
      );
    }
    out.city = c.city;
    out.branchId = c.branch_id;
  }
  const area = str('area');
  if (area !== undefined) {
    if (area.length > 100) throw new BadRequestException('area is too long.');
    out.area = area;
  }
  const pincode = str('pincode');
  if (pincode !== undefined) {
    if (!/^[1-9]\d{5}$/.test(pincode)) throw new BadRequestException('pincode must be 6 digits.');
    out.pincode = pincode;
  }
  const ecName = str('emergency_contact_name');
  if (ecName !== undefined) {
    if (ecName.length < 2 || ecName.length > 200) throw new BadRequestException('emergency_contact_name must be 2–200 characters.');
    out.emergencyContactName = ecName;
  }
  const ecMobile = str('emergency_contact_mobile');
  if (ecMobile !== undefined) {
    const d = digits10(ecMobile);
    if (!/^[6-9]\d{9}$/.test(d)) throw new BadRequestException('emergency_contact_mobile must be a 10-digit mobile number.');
    if (d === digits10(ctx.ownMobile)) throw new BadRequestException("The emergency contact can't be your own number.");
    out.emergencyContactMobile = d;
  }
  if (body.languages !== undefined && body.languages !== null) {
    const list = Array.isArray(body.languages) ? body.languages : String(body.languages).split(',');
    const langs = [...new Set(list.map((l) => String(l).trim()).filter(Boolean))];
    if (langs.length > 10 || langs.some((l) => l.length > 40)) throw new BadRequestException('languages: up to 10 names.');
    out.languages = langs;
  }
  const alt = str('alternate_phone');
  if (alt !== undefined) {
    const d = digits10(alt);
    if (!/^[6-9]\d{9}$/.test(d)) throw new BadRequestException('alternate_phone must be a 10-digit mobile number.');
    out.alternatePhone = d;
  }
  const email = str('email');
  if (email !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new BadRequestException('email is not valid.');
    out.email = email.toLowerCase();
  }
  const guardian = str('father_or_husband_name');
  if (guardian !== undefined) {
    if (guardian.length < 2 || guardian.length > 150 || !/^[\p{L} .'-]+$/u.test(guardian)) {
      throw new BadRequestException('father_or_husband_name must be 2–150 letters.');
    }
    out.fatherOrHusbandName = guardian;
  }
  const exp = str('experience_years');
  if (exp !== undefined) {
    const n = Number(exp);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new BadRequestException('experience_years must be a whole number 0–50.');
    out.experienceYears = n;
  }
  return out;
}

/** The S1 fields still empty on a staff row, by the names the app uses. */
export function staffProfileMissing(
  s: Pick<StaffApplicant, 'fullName' | 'dateOfBirth' | 'series' | 'address' | 'emergencyContactName' | 'emergencyContactMobile' | 'metadata'>,
): string[] {
  const m = (s.metadata ?? {}) as Record<string, unknown>;
  const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
  return [
    !has(s.fullName) && 'full_name',
    !s.dateOfBirth && 'date_of_birth',
    !has(m.gender) && 'gender',
    !s.series && 'series',
    !has(s.address) && 'address',
    !has(m.city) && 'city',
    !has(m.pincode) && 'pincode',
    (!has(s.emergencyContactName) || !has(s.emergencyContactMobile)) && 'emergency_contact',
  ].filter((x): x is string => !!x);
}

/** serviceableCities() for the branches that are active right now. */
export async function activeServiceableCities(prisma: PrismaService): Promise<ServiceableCity[]> {
  return serviceableCities(await prisma.branch.findMany({ where: { isActive: true }, select: { id: true, city: true } }));
}

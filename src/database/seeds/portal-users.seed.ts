import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  PORTAL_ADMIN_PHONE,
  PORTAL_ADMIN_TOTP_SECRET,
  PORTAL_BRANCH_ID,
  PORTAL_USER_PHONES,
  PORTAL_USERS,
} from './portal-users.constants';

export interface PortalSeedResult {
  seeded: number;
  password: string;
  phones: string[];
}

type PrismaLike = Pick<PrismaClient, 'branch' | 'user' | '$queryRaw'>;

function portalAdminMetadata(existing?: Record<string, unknown>) {
  return {
    ...(existing ?? {}),
    totp_secret: PORTAL_ADMIN_TOTP_SECRET,
    totp_enabled: false,
  };
}

/** Reset portal demo Admin 2FA when stuck on an orphaned random secret. */
export async function ensurePortalAdmin2fa(prisma: PrismaLike): Promise<boolean> {
  const admin = await prisma.user.findUnique({
    where: { phone: PORTAL_ADMIN_PHONE },
    select: { id: true, metadata: true },
  });
  if (!admin) return false;

  const current = (admin.metadata ?? {}) as Record<string, unknown>;
  if (current.totp_secret === PORTAL_ADMIN_TOTP_SECRET) {
    return false;
  }

  await prisma.user.update({
    where: { id: admin.id },
    data: { metadata: portalAdminMetadata(current) },
  });
  return true;
}

export async function countPortalUsers(prisma: PrismaLike): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM users
    WHERE phone = ANY(${PORTAL_USER_PHONES}::text[])
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function seedPortalUsers(
  prisma: PrismaLike,
  options?: { password?: string; force?: boolean },
): Promise<PortalSeedResult> {
  const password = options?.password ?? process.env.SEED_PASSWORD ?? 'HomeGenny@2024';
  const existing = await countPortalUsers(prisma);

  if (!options?.force && existing >= PORTAL_USERS.length) {
    return { seeded: 0, password, phones: [] };
  }

  const hash = await bcrypt.hash(password, 12);

  await prisma.branch.upsert({
    where: { id: PORTAL_BRANCH_ID },
    create: {
      id: PORTAL_BRANCH_ID,
      name: 'HomeGenny Delhi NCR HQ',
      city: 'New Delhi',
      state: 'Delhi',
      email: 'delhi@homegenny.com',
      gstin: '07AABCH1234A1Z8',
    },
    update: { name: 'HomeGenny Delhi NCR HQ' },
  });

  const seededPhones: string[] = [];
  for (const u of PORTAL_USERS) {
    const isPortalAdmin = u.phone === PORTAL_ADMIN_PHONE;
    const adminMeta = isPortalAdmin ? portalAdminMetadata() : undefined;

    await prisma.user.upsert({
      where: { phone: u.phone },
      create: {
        branchId: PORTAL_BRANCH_ID,
        role: u.role,
        fullName: u.fullName,
        phone: u.phone,
        email: u.email,
        passwordHash: hash,
        isActive: true,
        ...(adminMeta ? { metadata: adminMeta } : {}),
      },
      update: {
        branchId: PORTAL_BRANCH_ID,
        passwordHash: hash,
        fullName: u.fullName,
        role: u.role,
        email: u.email,
        isActive: true,
        refreshTokenHash: null,
        activeSessionId: null,
        ...(adminMeta ? { metadata: adminMeta } : {}),
      },
    });
    seededPhones.push(u.phone);
  }

  await ensurePortalAdmin2fa(prisma);

  return { seeded: seededPhones.length, password, phones: seededPhones };
}

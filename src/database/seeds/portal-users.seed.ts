import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PORTAL_BRANCH_ID, PORTAL_USER_PHONES, PORTAL_USERS } from './portal-users.constants';

export interface PortalSeedResult {
  seeded: number;
  password: string;
  phones: string[];
}

type PrismaLike = Pick<PrismaClient, 'branch' | 'user' | '$queryRaw'>;

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
      },
    });
    seededPhones.push(u.phone);
  }

  return { seeded: seededPhones.length, password, phones: seededPhones };
}

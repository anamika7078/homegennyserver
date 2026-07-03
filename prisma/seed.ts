import { PrismaClient, StaffSeries, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { loadSeedEnv } from '../src/database/seeds/load-env';
import { seedDemoData } from '../src/database/seeds/demo-data.seed';

loadSeedEnv();

const prisma = new PrismaClient();
const BRANCH_ID = '00000000-0000-0000-0000-000000000001';
const PASSWORD = process.env.SEED_PASSWORD ?? 'HomeGenny@2024';

const SCENARIO_SEEDS = [
  { code: 'SC-01', series: StaffSeries.SKILLED_CARE, title: 'Standard SC onboarding', severity: 'LOW' },
  { code: 'SC-12', series: StaffSeries.SKILLED_CARE, title: 'Scope violation — BM escalation', severity: 'CRITICAL', requiresBm: true },
  { code: 'UC-01', series: StaffSeries.UNSKILLED_CARE, title: 'Standard UC onboarding', severity: 'LOW' },
  { code: 'UC-12', series: StaffSeries.UNSKILLED_CARE, title: 'Scope boundary refusal', severity: 'CRITICAL', requiresBm: true },
  { code: 'DR-01', series: StaffSeries.DRIVER, title: 'Standard driver onboarding', severity: 'LOW' },
  { code: 'DR-07', series: StaffSeries.DRIVER, title: 'Traffic violations 1–2', severity: 'MEDIUM' },
  { code: 'M3X-01', series: StaffSeries.MAID, title: 'Standard maid onboarding', severity: 'LOW' },
];

const USERS: Array<{ phone: string; role: UserRole; fullName: string; email: string }> = [
  { phone: '9800000001', role: UserRole.BM, fullName: 'Amit Gupta', email: 'bm@homegenny.com' },
  { phone: '9800000002', role: UserRole.RM, fullName: 'Pooja Mishra', email: 'rm@homegenny.com' },
  { phone: '9800000003', role: UserRole.ADMIN, fullName: 'Super Admin', email: 'admin@homegenny.com' },
  { phone: '9800000004', role: UserRole.FINANCE, fullName: 'Rajesh Finance', email: 'finance@homegenny.com' },
  { phone: '9800000005', role: UserRole.TRAINER, fullName: 'Sunita Trainer', email: 'trainer@homegenny.com' },
  { phone: '9800000006', role: UserRole.ASSESSOR, fullName: 'Dr. Kavita Assessor', email: 'assessor@homegenny.com' },
  { phone: '9800000007', role: UserRole.SUPPORT, fullName: 'Ops Support', email: 'support@homegenny.com' },
];

async function seedUsers() {
  const hash = await bcrypt.hash(PASSWORD, 12);

  await prisma.branch.upsert({
    where: { id: BRANCH_ID },
    create: {
      id: BRANCH_ID,
      name: 'HomeGenny Delhi NCR HQ',
      city: 'New Delhi',
      state: 'Delhi',
      email: 'delhi@homegenny.com',
      gstin: '07AABCH1234A1Z8',
    },
    update: { name: 'HomeGenny Delhi NCR HQ' },
  });

  for (const u of USERS) {
    await prisma.user.upsert({
      where: { phone: u.phone },
      create: {
        branchId: BRANCH_ID,
        role: u.role,
        fullName: u.fullName,
        phone: u.phone,
        email: u.email,
        passwordHash: hash,
        isActive: true,
      },
      update: {
        passwordHash: hash,
        fullName: u.fullName,
        role: u.role,
        isActive: true,
      },
    });
    console.log(`  ✓ ${u.role.padEnd(8)} ${u.phone}  ${u.fullName}`);
  }
}

async function seedScenarios() {
  for (const s of SCENARIO_SEEDS) {
    await prisma.scenarioDefinition.upsert({
      where: { code: s.code },
      create: {
        code: s.code,
        series: s.series,
        title: s.title,
        severity: s.severity,
        requiresBm: s.requiresBm ?? false,
        notifyRoles: s.requiresBm ? [UserRole.BM] : [UserRole.RM],
        locksActions: s.requiresBm ? ['advance_stage'] : [],
        uiState: { banner: s.severity === 'CRITICAL' ? 'critical' : 'info' },
      },
      update: { title: s.title, severity: s.severity },
    });
  }
}

async function seedRbac() {
  const perms = [
    { code: 'rm.intake', name: 'Intake', module: 'rm' },
    { code: 'finance.payroll', name: 'Payroll', module: 'finance' },
    { code: 'system.users.manage', name: 'Users', module: 'system' },
  ];
  for (const p of perms) {
    await prisma.permission.upsert({
      where: { code: p.code },
      create: p,
      update: p,
    });
  }
}

async function main() {
  console.log('[SEED] Users (password: ' + PASSWORD + ')');
  await seedUsers();
  await seedScenarios();
  await seedRbac();
  await seedDemoData(prisma);
  console.log('[SEED] Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

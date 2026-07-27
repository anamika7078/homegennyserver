import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const REQUIRED = [
  'agreements',
  'alarms',
  'clients',
  'notification_logs',
  'staff_applicants',
  'users',
];

async function main() {
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'agreements',
        'alarms',
        'clients',
        'notification_logs',
        'staff_applicants',
        'users'
      )
    ORDER BY table_name
  `;
  const found = rows.map((r) => r.table_name);
  const missing = REQUIRED.filter((t) => !found.includes(t));
  console.log('FOUND:', found.join(', ') || '(none)');
  console.log('MISSING:', missing.join(', ') || '(none)');
  process.exit(missing.length > 0 ? 2 : 0);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const enums = await prisma.$queryRaw<{ typname: string }[]>`
    SELECT typname FROM pg_type
    WHERE typname LIKE '%agreement%'
  `;
  console.log('types', enums);
  const cols = await prisma.$queryRaw`
    SELECT column_name, udt_name FROM information_schema.columns
    WHERE table_name = 'agreements'
  `;
  console.log('cols', cols);
  const hasStaff = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'agreements' AND column_name = 'staff_id'
    ) AS exists
  `;
  console.log('staff_id', hasStaff);
}

main().finally(() => prisma.$disconnect());

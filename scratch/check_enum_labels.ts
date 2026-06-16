import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const types = await prisma.$queryRaw<{ enumlabel: string }[]>`
    SELECT enumlabel FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'agreements_type_enum'
    ORDER BY enumsortorder
  `;
  const statuses = await prisma.$queryRaw<{ enumlabel: string }[]>`
    SELECT enumlabel FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'agreements_status_enum'
    ORDER BY enumsortorder
  `;
  console.log('types', types);
  console.log('statuses', statuses);
}

main().finally(() => prisma.$disconnect());

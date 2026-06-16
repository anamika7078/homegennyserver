import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw<
    { column_name: string; data_type: string }[]
  >`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agreements'
    ORDER BY ordinal_position
  `;
  console.log(rows);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

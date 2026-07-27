import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  console.log(rows.map((r) => r.table_name).join('\n'));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

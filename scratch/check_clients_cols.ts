import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients'
    ORDER BY ordinal_position
  `;
  console.log(rows.map((r) => r.column_name));
}

main().finally(() => prisma.$disconnect());

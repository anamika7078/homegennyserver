import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const rows = await p.$queryRaw<{ column_name: string; udt_name: string }[]>`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_name = 'staff_applicants'
      AND udt_name NOT IN ('uuid', 'varchar', 'text', 'jsonb', 'bool', 'date', 'timestamp')
    ORDER BY column_name`;
  console.log(rows);
  await p.$disconnect();
}

main();

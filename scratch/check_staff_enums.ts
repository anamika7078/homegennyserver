import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const rows = await p.$queryRaw<{ typname: string }[]>`
    SELECT DISTINCT t.typname
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname LIKE '%staff%'
       OR t.typname LIKE '%pipeline%'
       OR t.typname LIKE '%pv%'
       OR t.typname = 'staff_series'
       OR t.typname = 'pipeline_stage'
       OR t.typname = 'pv_status'
    ORDER BY 1`;
  console.log(rows);
  await p.$disconnect();
}

main();

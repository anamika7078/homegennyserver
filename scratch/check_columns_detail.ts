import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const rows = await p.$queryRaw<
    { column_name: string; data_type: string; is_nullable: string }[]
  >`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'staff_applicants'
    ORDER BY ordinal_position`;
  for (const r of rows) {
    console.log(`${r.column_name}\t${r.data_type}\t${r.is_nullable}`);
  }
  await p.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

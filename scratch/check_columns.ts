import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const rows = await p.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'staff_applicants' ORDER BY ordinal_position`;
  console.log(rows.map((r) => r.column_name).join('\n'));
  await p.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

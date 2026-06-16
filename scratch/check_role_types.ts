import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const rows = await p.$queryRaw<{ role_types: unknown }[]>`
    SELECT role_types FROM staff_applicants LIMIT 3`;
  console.log(rows);
  await p.$disconnect();
}

main();

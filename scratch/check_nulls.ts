import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  const rows = await p.$queryRaw<{ col: string; nulls: bigint }[]>`
    SELECT 'branch_id' as col, COUNT(*) FILTER (WHERE branch_id IS NULL) as nulls FROM staff_applicants
    UNION ALL SELECT 'full_name', COUNT(*) FILTER (WHERE full_name IS NULL) FROM staff_applicants
    UNION ALL SELECT 'date_of_birth', COUNT(*) FILTER (WHERE date_of_birth IS NULL) FROM staff_applicants
    UNION ALL SELECT 'mobile', COUNT(*) FILTER (WHERE mobile IS NULL) FROM staff_applicants
    UNION ALL SELECT 'address', COUNT(*) FILTER (WHERE address IS NULL) FROM staff_applicants`;
  console.log(rows);
  await p.$disconnect();
}

main();

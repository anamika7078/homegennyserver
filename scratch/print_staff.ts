import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const count = await prisma.staffApplicant.count();
  const first = await prisma.staffApplicant.findFirst({
    select: { id: true, fullName: true, mobile: true, email: true, series: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log({ count, first });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());


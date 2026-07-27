const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const users = await prisma.user.findMany({
    where: { phone: { in: ['9800000001', '9800000004'] } },
    select: { phone: true, passwordHash: true, isActive: true }
  });
  console.dir(users);
}

check().catch(console.error).finally(() => prisma.$disconnect());

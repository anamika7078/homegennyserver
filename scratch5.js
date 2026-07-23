const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const batches = await prisma.trainingBatch.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log("Recent batches:", batches);
}
main().finally(() => prisma.$disconnect());

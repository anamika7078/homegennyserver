const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.trainingBatch.updateMany({
    data: { trainerId: 'fa86641e-45be-48e7-8d66-1cc741f142bd', trainerName: 'Sunita Trainer' }
  });
  console.log("Assigned all batches to Sunita!");
}
main().finally(() => prisma.$disconnect());

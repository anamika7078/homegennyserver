const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const batches = await prisma.trainingBatch.findMany();
  console.log("Total Batches:", batches.length);
  if (batches.length > 0) {
    console.log("Batches:", JSON.stringify(batches, null, 2));
  }
}
main().finally(() => prisma.$disconnect());

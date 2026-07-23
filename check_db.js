const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const emps = await prisma.employee.findMany();
  console.log('Employees in DB:', emps.length);
  emps.forEach(e => console.log(`- ${e.fullName} (${e.mobile}) ID: ${e.id}`));

  const trainers = await prisma.user.findMany({ where: { role: 'TRAINER' } });
  console.log('\nTrainers in DB:', trainers.length);
  trainers.forEach(t => console.log(`- ${t.fullName} (${t.phone}) ID: ${t.id}`));
  
  const batches = await prisma.trainingBatch.findMany();
  console.log('\nBatches in DB:', batches.length);
  batches.forEach(b => console.log(`- ${b.batchCode} TrainerName: ${b.trainerName} TrainerId: ${b.trainerId}`));
}

main().finally(() => prisma.$disconnect());

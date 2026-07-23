const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const emp = await prisma.employee.findFirst({where:{mobile:'9800000005'}});
  if(emp){
    await prisma.$queryRawUnsafe(`UPDATE training_batches SET trainer_id = $1::uuid`, emp.id);
    console.log('Updated all batches with trainer_id:', emp.id);
  }
}

main().finally(() => prisma.$disconnect());

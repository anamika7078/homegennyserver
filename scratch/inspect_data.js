const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const staffCount = await prisma.staffApplicant.count();
  const batchCount = await prisma.trainingBatch.count();
  const enrollCount = await prisma.batchEnrollment.count();
  console.log({ staffCount, batchCount, enrollCount });
  
  if (staffCount > 0) {
    const staff = await prisma.staffApplicant.findMany({ take: 5 });
    console.log('Staff samples:', staff.map(s => ({ id: s.id, name: s.fullName, code: s.staffCode })));
  }
}

check().catch(console.error).finally(() => prisma.$disconnect());

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const batchId = '8267205d-ae00-4963-8a16-f482a48a8284';
  const enrolls = await prisma.$queryRawUnsafe('SELECT * FROM batch_enrollments');
  console.log("All Enrollments:", enrolls);
}
main().finally(() => prisma.$disconnect());

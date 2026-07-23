const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ where: { role: 'TRAINER' } });
  console.log("Trainers:", users.map(u => ({ id: u.id, fullName: u.fullName, phone: u.phone })));
  
  const emps = await prisma.$queryRawUnsafe('SELECT id, full_name, mobile FROM employees WHERE department = $1', 'Training');
  console.log("Trainer Employees:", emps);
}
main().finally(() => prisma.$disconnect());

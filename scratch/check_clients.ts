import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const clients = await prisma.$queryRaw<{ id: string; full_name: string }[]>`
    SELECT id, full_name FROM clients LIMIT 5
  `;
  console.log('clients', clients);
  const staff = await prisma.$queryRaw<{ id: string; full_name: string }[]>`
    SELECT id, full_name FROM staff_applicants LIMIT 5
  `;
  console.log('staff', staff);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

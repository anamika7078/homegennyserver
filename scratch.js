const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.$queryRaw`SELECT * FROM assessors LIMIT 5`
  .then(console.log)
  .catch(console.error)
  .finally(() => prisma.$disconnect());

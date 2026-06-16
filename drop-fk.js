const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  try {
    await prisma.$executeRaw`ALTER TABLE assessments DROP CONSTRAINT IF EXISTS "FK_d516e63ab3c0bb2a2f318a7e24f"`;
    console.log("Dropped constraint successfully.");
  } catch (err) {
    console.error("Error dropping constraint:", err);
  } finally {
    await prisma.$disconnect();
  }
}
run();

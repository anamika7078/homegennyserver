const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  try {
    const res = await prisma.$executeRaw`
      INSERT INTO "assessments"("candidate_id", "assessor_id", "series", "assessment_type", "attempt_number", "remarks", "status") 
      VALUES ('11111111-1111-1111-1111-111111111111', 'c0f44de6-59df-4543-9971-b4ea4dbb814a', 'SC', 'SC', 1, 'test', 'PENDING')
    `;
    console.log("INSERT successful!", res);
  } catch (err) {
    console.error("ERROR:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}
run();

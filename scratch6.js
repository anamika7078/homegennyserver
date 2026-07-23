const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const userId = '4f8454e5-8a5c-48dd-b000-727743156120';
  const branchClause = "AND b.branch_id = '00000000-0000-0000-0000-000000000001'::uuid";
  const empId = 'fa86641e-45be-48e7-8d66-1cc741f142bd'; // Sunita Trainer
  
  const trainerClause = `AND (b.trainer_id = '${empId}'::uuid OR b.rm_id = '${userId}'::uuid)`;
  
  const rows = await prisma.$queryRawUnsafe(`
      SELECT b.id, b.batch_code, b.trainer_name, b.trainer_id, b.rm_id
      FROM training_batches b
      WHERE 1=1 ${branchClause} ${trainerClause}
      ORDER BY b.created_at DESC
    `);
  console.log("Returned batches:", rows);
}
main().finally(() => prisma.$disconnect());

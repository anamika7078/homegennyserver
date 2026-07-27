import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Checking database connection and tables...");
  try {
    const usersCount = await prisma.user.count();
    console.log(`Users table exists. Count: ${usersCount}`);
  } catch (e: any) {
    console.error("Error querying User:", e.message || e);
  }
  try {
    const approvalsCount = await prisma.adminApproval.count();
    console.log(`AdminApproval table exists. Count: ${approvalsCount}`);
  } catch (e: any) {
    console.error("Error querying AdminApproval:", e.message || e);
  }
  try {
    const auditLogsCount = await prisma.adminAuditLog.count();
    console.log(`AdminAuditLog table exists. Count: ${auditLogsCount}`);
  } catch (e: any) {
    console.error("Error querying AdminAuditLog:", e.message || e);
  }
  try {
    const branchesCount = await prisma.branch.count();
    console.log(`Branch table exists. Count: ${branchesCount}`);
  } catch (e: any) {
    console.error("Error querying Branch:", e.message || e);
  }
  await prisma.$disconnect();
}

main();

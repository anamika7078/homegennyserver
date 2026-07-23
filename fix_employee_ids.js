/**
 * fix_employee_ids.js
 * Re-generates employeeId for every existing employee using the new format:
 *   FIRSTNAME (uppercase) + 3-digit suffix  →  e.g. ANAMIKA001
 *
 * Run: node fix_employee_ids.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function buildPrefix(fullName) {
  const firstName = fullName.trim().split(/\s+/)[0];
  return firstName.replace(/[^a-zA-Z]/g, '').toUpperCase();
}

async function main() {
  const employees = await prisma.employee.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' }, // process oldest first so 001 goes to the first one
    select: { id: true, fullName: true, employeeId: true },
  });

  console.log(`Found ${employees.length} employees to re-ID.\n`);

  // Track newly-assigned IDs within this run to avoid collisions between updates
  const usedInRun = new Set();

  for (const emp of employees) {
    const prefix = buildPrefix(emp.fullName);

    // Fetch IDs already in DB with this prefix
    const dbIds = await prisma.employee.findMany({
      where: {
        employeeId: { startsWith: prefix, mode: 'insensitive' },
        id: { not: emp.id }, // exclude this employee's own old ID
      },
      select: { employeeId: true },
    });

    const existingUppercase = new Set([
      ...dbIds.map((e) => e.employeeId.toUpperCase()),
      ...usedInRun,
    ]);

    let suffix = 1;
    let newId = `${prefix}${String(suffix).padStart(3, '0')}`;
    while (existingUppercase.has(newId)) {
      suffix++;
      newId = `${prefix}${String(suffix).padStart(3, '0')}`;
    }

    usedInRun.add(newId);

    if (emp.employeeId === newId) {
      console.log(`  ✓ ${emp.fullName.padEnd(25)} — already correct: ${newId}`);
      continue;
    }

    await prisma.employee.update({
      where: { id: emp.id },
      data: { employeeId: newId },
    });
    console.log(`  ✎ ${emp.fullName.padEnd(25)} — ${emp.employeeId} → ${newId}`);
  }

  console.log('\n=== Employee IDs updated successfully ===');
}

main()
  .catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

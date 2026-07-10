const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const staff = await prisma.staffApplicant.findMany();
  
  // Track counts per name
  const nameCounts = {};

  for (const emp of staff) {
    const fullName = emp.fullName || 'unknown';
    const firstName = fullName.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (!nameCounts[firstName]) {
      nameCounts[firstName] = 1;
    } else {
      nameCounts[firstName]++;
    }

    const seqNumber = nameCounts[firstName];
    const newStaffCode = `${firstName}${seqNumber.toString().padStart(3, '0')}`;
    
    console.log(`Updating ${emp.staffCode} -> ${newStaffCode}`);
    
    await prisma.staffApplicant.update({
      where: { id: emp.id },
      data: { staffCode: newStaffCode }
    });
  }

  console.log('Update complete!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

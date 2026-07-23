const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find the trainer user
  const trainer = await prisma.user.findFirst({
    where: { role: 'TRAINER' }
  });
  
  if (!trainer) {
    console.log('No trainer found.');
    return;
  }
  
  console.log(`Found trainer: ${trainer.fullName} (${trainer.phone})`);
  
  // Check if branch exists, if not get first branch
  let branchId = trainer.branchId;
  if (!branchId) {
    const branch = await prisma.branch.findFirst();
    branchId = branch.id;
  }
  
  // Find a category for employee
  let cat = await prisma.employeeCategory.findFirst();
  if (!cat) {
    cat = await prisma.employeeCategory.create({
      data: { name: 'Trainer Staff' }
    });
  }

  // Check if employee exists
  let emp = await prisma.employee.findFirst({
    where: { mobile: trainer.phone }
  });
  
  if (!emp) {
    emp = await prisma.employee.create({
      data: {
        employeeId: 'EMP-TRAINER-01',
        fullName: trainer.fullName,
        mobile: trainer.phone,
        dateOfBirth: new Date('1990-01-01'),
        gender: 'Female',
        address: 'Trainer Address',
        city: 'Delhi',
        state: 'Delhi',
        pincode: '110001',
        emergencyContact: { name: 'Contact', phone: '9999999999' },
        joiningDate: new Date(),
        department: 'Training',
        designation: 'Lead Trainer',
        employmentType: 'Full-time',
        salary: 50000,
        status: 'ACTIVE',
        branchId: branchId,
        categoryId: cat.id
      }
    });
    console.log(`Created employee for trainer: ${emp.id}`);
  } else {
    console.log(`Employee already exists for trainer: ${emp.id}`);
  }
}

main().finally(() => prisma.$disconnect());

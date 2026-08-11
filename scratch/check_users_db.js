const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      phone: true,
      email: true,
      fullName: true,
      role: true,
      passwordHash: true,
      isActive: true,
    }
  });

  console.log('Total Users in DB:', users.length);
  for (const u of users) {
    let match = false;
    if (u.passwordHash) {
      try {
        match = await bcrypt.compare('HomeGenny@2024', u.passwordHash);
      } catch (e) {
        match = false;
      }
    }
    console.log({
      id: u.id,
      phone: u.phone,
      email: u.email,
      name: u.fullName,
      role: u.role,
      isActive: u.isActive,
      hasPasswordHash: !!u.passwordHash,
      passwordStartsWith2: u.passwordHash ? u.passwordHash.startsWith('$2') : false,
      passwordMatchesDefault: match,
    });
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  prisma.$disconnect();
});

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('HomeGenny@2024', 12);
  console.log('New hash for HomeGenny@2024:', hash);

  // Reset 9800000003, 9800000002, 9800000001 to HomeGenny@2024 so all demo accounts work as stated on login screen!
  const phonesToUpdate = ['9800000003', '9800000002', '9800000001'];
  for (const phone of phonesToUpdate) {
    const res = await prisma.user.updateMany({
      where: { phone },
      data: { passwordHash: hash }
    });
    console.log(`Updated ${phone}:`, res.count);
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  prisma.$disconnect();
});

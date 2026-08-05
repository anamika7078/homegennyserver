const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const phone = '9094951000';
  const email = 'mr.hunesh@gmail.com';

  console.log('Checking existing user with phone:', phone);
  const byPhone = await prisma.user.findFirst({ where: { phone } });
  console.log('User by phone:', byPhone);

  console.log('Checking existing user with email:', email);
  const byEmail = await prisma.user.findFirst({ where: { email } });
  console.log('User by email:', byEmail);

  try {
    const newUser = await prisma.user.create({
      data: {
        fullName: 'Hunesh Sharma Test',
        phone: '9094951000',
        email: 'mr.hunesh@gmail.com',
        role: 'FINANCE',
        passwordHash: '$2a$12$eImiTXuWVxfM37uY4JANjO.g79X7y58JpL',
      },
    });
    console.log('Created user successfully:', newUser);
  } catch (err) {
    console.error('CRITICAL ERROR creating user:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();

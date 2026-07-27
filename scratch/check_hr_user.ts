import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main(){
  const user = await prisma.users.findUnique({ where: { phone: '9800000008' } });
  console.log('User record:', user);
}
main().catch(e=>{console.error('Error:', e); process.exit(1);}).finally(()=> prisma.$disconnect());

import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();
  try {
    const items = await p.staffApplicant.findMany({
      where: { deletedAt: null },
      take: 3,
      orderBy: { updatedAt: 'desc' },
    });
    console.log('findMany OK, count sample:', items.length);
    if (items[0]) {
      console.log('sample:', items[0].staffCode, items[0].pipelineStage, items[0].restrictedListFlag);
    }
  } catch (e) {
    console.error('findMany FAILED:', e);
    process.exit(1);
  }

  try {
    const created = await p.staffApplicant.create({
      data: {
        staffCode: `HG-TEST-${Date.now()}`,
        branchId: '00000000-0000-0000-0000-000000000001',
        series: 'SKILLED_CARE',
        fullName: 'API Test User',
        dateOfBirth: new Date('1990-01-01'),
        mobile: '9999999999',
        address: 'Test',
        pipelineStage: 'S1_INTAKE',
        metadata: { test: true },
      },
    });
    console.log('create OK:', created.id);
    await p.staffApplicant.delete({ where: { id: created.id } });
    console.log('cleanup OK');
  } catch (e) {
    console.error('create FAILED:', e);
    process.exit(1);
  }

  await p.$disconnect();
}

main();

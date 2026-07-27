import { PrismaClient } from '@prisma/client';
import { loadSeedEnv } from '../src/database/seeds/load-env';
import { seedDemoData } from '../src/database/seeds/demo-data.seed';

loadSeedEnv();

const prisma = new PrismaClient();

seedDemoData(prisma)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

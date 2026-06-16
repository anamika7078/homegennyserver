import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const enums = await prisma.$queryRaw<{ typname: string }[]>`
    SELECT typname FROM pg_type
    WHERE typtype = 'e' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    ORDER BY typname
  `;
  console.log(enums.map((e) => e.typname).join('\n'));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

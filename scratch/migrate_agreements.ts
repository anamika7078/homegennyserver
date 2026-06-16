import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SQL = `
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES staff_applicants(id);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS placement_id UUID;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS pdf_url TEXT;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ(6);
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_agreements_staff ON agreements(staff_id);
`;

async function main() {
  for (const stmt of SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    console.log('Running:', stmt.slice(0, 60) + '…');
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

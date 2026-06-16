import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('[DB-SECURITY] Applying database security triggers...');

    // 1. Define prevent_update_delete function
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION prevent_update_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Table is append-only. Modification or deletion is not allowed.';
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 2. Apply trigger to pipeline_events
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS prevent_update_delete_pipeline_events ON pipeline_events;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER prevent_update_delete_pipeline_events
      BEFORE UPDATE OR DELETE ON pipeline_events
      FOR EACH ROW EXECUTE FUNCTION prevent_update_delete();
    `);
    console.log('[DB-SECURITY] ✓ Append-only trigger applied to pipeline_events');

    // 3. Apply trigger to admin_audit_logs
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS prevent_update_delete_admin_audit_logs ON admin_audit_logs;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER prevent_update_delete_admin_audit_logs
      BEFORE UPDATE OR DELETE ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_update_delete();
    `);
    console.log('[DB-SECURITY] ✓ Append-only trigger applied to admin_audit_logs');

    console.log('[DB-SECURITY] All security triggers applied successfully!');
  } catch (error) {
    console.error('[DB-SECURITY] Failed to apply security triggers:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

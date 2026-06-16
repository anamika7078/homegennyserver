import { AppDataSource } from '../src/database/data-source';

async function migrate() {
  await AppDataSource.initialize();
  try {
    console.log('Adding active_session_id to users table...');
    await AppDataSource.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id UUID');
    console.log('Done.');
  } catch (e) {
    console.error('Migration failed:', e);
  } finally {
    await AppDataSource.destroy();
  }
}
migrate();

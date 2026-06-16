import * as path from 'path';
import * as dotenv from 'dotenv';

/** Load env for CLI scripts: local .env wins unless NODE_ENV=production */
export function loadSeedEnv(): string {
  const root = path.join(__dirname, '..', '..', '..');
  dotenv.config({ path: path.join(root, '.env') });
  dotenv.config({ path: path.join(root, '.env.local'), override: true });
  if (process.env.NODE_ENV === 'production') {
    dotenv.config({ path: path.join(root, '.env.production'), override: true });
  }

  if (!process.env.DATABASE_URL && process.env.DB_URL) {
    process.env.DATABASE_URL = process.env.DB_URL;
  }
  if (!process.env.DATABASE_URL) {
    console.error('[SEED] Set DATABASE_URL or DB_URL in backend/.env');
    process.exit(1);
  }
  return process.env.DATABASE_URL;
}

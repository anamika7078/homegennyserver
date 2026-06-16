/**
 * Seeds all role logins (see users.seed.ts).
 * Run: npm run seed:run
 */
import { loadSeedEnv } from './load-env';

loadSeedEnv();
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./users.seed');

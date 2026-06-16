import { registerAs } from '@nestjs/config';

/** TypeORM auto-DDL. Off when using homegenny_schema.sql or when tables are owned by another role. */
function typeormSynchronize(): boolean {
  const raw = process.env.TYPEORM_SYNCHRONIZE?.toLowerCase();
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  return process.env.NODE_ENV === 'development';
}

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL ?? process.env.DB_URL,
  synchronize: typeormSynchronize(),
  logging: process.env.DB_LOGGING === 'true',
  maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '20', 10),
}));

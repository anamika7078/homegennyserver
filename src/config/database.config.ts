import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  synchronize: process.env.NODE_ENV === 'development',
  logging: process.env.DB_LOGGING === 'true',
  maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '20', 10),
}));

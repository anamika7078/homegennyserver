import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// Used by TypeOrmModule.forRootAsync() in app.module.ts
export const typeOrmConfig = (config: ConfigService): TypeOrmModuleOptions => ({
  type:             'postgres',
  url:              config.get<string>('database.url'),
  autoLoadEntities: true,
  synchronize:      config.get('app.env') === 'development',   // NEVER true in prod
  logging:          config.get('app.env') === 'development' ? ['query', 'error'] : ['error'],
  ssl:              config.get('app.env') === 'production' ? { rejectUnauthorized: false } : false,
  extra: {
    max:                   20,
    min:                    2,
    idleTimeoutMillis:  30_000,
    connectionTimeoutMillis: 5_000,
  },
});

// Separate DataSource for TypeORM CLI (migrations: npm run migration:run)
// This reads directly from process.env so it works outside the NestJS container
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: '.env.production' });

export const AppDataSource = new DataSource({
  type:       'postgres',
  url:        process.env['DATABASE_URL'],
  ssl:        process.env['NODE_ENV'] === 'production' ? { rejectUnauthorized: false } : false,
  entities:   [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
});

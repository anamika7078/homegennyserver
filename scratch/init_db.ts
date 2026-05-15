import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.production' });

async function init() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const ds = new DataSource({
    type: 'postgres',
    url: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await ds.initialize();
    console.log('Connected to database');

    const schemaPath = path.join(__dirname, '..', 'src', 'database', 'homegenny_schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    console.log('Executing schema SQL...');
    await ds.query(schemaSql);
    console.log('Schema initialized successfully');

    await ds.destroy();
  } catch (err) {
    console.error('Error initializing schema:', err);
    process.exit(1);
  }
}

init();

const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://homegenny_user:root@localhost:5432/homegenny' });
client.connect().then(async () => {
  console.log('Running database schema fix for invoice & payroll tables...');

  // Enable pgcrypto / uuid extension if available
  await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

  // Fix client_invoices.id
  await client.query('ALTER TABLE client_invoices ALTER COLUMN id SET DEFAULT gen_random_uuid();');
  console.log('Fixed client_invoices.id default -> gen_random_uuid()');

  // Fix payroll_records.id
  await client.query('ALTER TABLE payroll_records ALTER COLUMN id SET DEFAULT gen_random_uuid();');
  console.log('Fixed payroll_records.id default -> gen_random_uuid()');

  // Fix employee_payrolls.id & updated_at
  await client.query('ALTER TABLE employee_payrolls ALTER COLUMN id SET DEFAULT gen_random_uuid();');
  await client.query('ALTER TABLE employee_payrolls ALTER COLUMN updated_at SET DEFAULT NOW();');
  console.log('Fixed employee_payrolls.id default -> gen_random_uuid(), updated_at -> NOW()');

  client.end();
}).catch(err => { console.error('Migration error:', err); client.end(); });

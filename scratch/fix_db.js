const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to DB');
  
  try {
    // Try to force cast the column to varchar
    await client.query(`ALTER TABLE agreements ALTER COLUMN type TYPE VARCHAR(40) USING type::VARCHAR;`);
    console.log('Successfully altered agreements.type column');
  } catch (e) {
    console.error('Error altering table:', e.message);
  }
  
  await client.end();
}

main();

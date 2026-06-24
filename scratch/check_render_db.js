const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('Error: Please provide DATABASE_URL environment variable.');
  console.error('Example: DATABASE_URL="postgresql://user:pass@host:port/db" node scratch/check_render_db.js');
  process.exit(1);
}

console.log('Connecting to database...');
const client = new Client({
  connectionString: dbUrl,
  ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

client.connect()
  .then(async () => {
    console.log('Connected successfully. Querying users...');
    const res = await client.query(
      `SELECT id, phone, role::text AS role, full_name, password_hash, is_active FROM users ORDER BY phone`
    );
    
    console.log(`\nFound ${res.rows.length} users in the database:\n`);
    for (const user of res.rows) {
      let pwdMatches = false;
      if (user.password_hash) {
        pwdMatches = await bcrypt.compare('HomeGenny@2024', user.password_hash);
      }
      console.log(`Phone: ${user.phone}`);
      console.log(`  Name:   ${user.full_name}`);
      console.log(`  Role:   ${user.role}`);
      console.log(`  Active: ${user.is_active}`);
      console.log(`  Hash:   ${user.password_hash}`);
      console.log(`  Password 'HomeGenny@2024' matches: ${pwdMatches}`);
      console.log('--------------------------------------------------');
    }
    
    await client.end();
  })
  .catch((e) => {
    console.error('Connection failed:', e.message);
    process.exit(1);
  });

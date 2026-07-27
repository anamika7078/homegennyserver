const { Client } = require('pg');

async function run() {
  const str = 'postgresql://postgres:root@localhost:5432/homegenny';
  const client = new Client({ connectionString: str });
  try {
    await client.connect();
    console.log(`Connected with ${str}!`);
    
    // Make user superuser to avoid any permission issues during migrations
    await client.query('ALTER USER homegenny_user SUPERUSER;');
    
    // Also change owner of all tables in public schema
    const res = await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public';
    `);
    
    for (const row of res.rows) {
      await client.query(`ALTER TABLE public.${row.tablename} OWNER TO homegenny_user;`);
    }

    console.log('Granted SUPERUSER and changed owners successfully.');
    await client.end();
  } catch (e) {
    console.log(`Failed for ${str}: ${e.message}`);
  }
}

run().catch(console.error);

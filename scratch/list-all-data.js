const { Client } = require('pg');

const DATABASES = ['homegenny', 'postgres'];

async function inspectDb(dbName) {
  const urls = [
    `postgresql://homegenny_user:root@localhost:5432/${dbName}`,
    `postgresql://postgres:root@localhost:5432/${dbName}`,
  ];

  let client;
  for (const url of urls) {
    const c = new Client({ connectionString: url });
    try {
      await c.connect();
      client = c;
      break;
    } catch {
      await c.end().catch(() => undefined);
    }
  }
  if (!client) {
    console.log(`\n=== ${dbName} === (could not connect)\n`);
    return;
  }

  console.log(`\n${'='.repeat(60)}\nDATABASE: ${dbName}\n${'='.repeat(60)}`);

  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );

  if (!tables.rows.length) {
    console.log('  (no public tables)');
    await client.end();
    return;
  }

  for (const { table_name } of tables.rows) {
    try {
      const count = await client.query(
        `SELECT COUNT(*)::int AS n FROM "${table_name}"`,
      );
      console.log(`  ${table_name.padEnd(22)} ${count.rows[0].n} rows`);
    } catch (e) {
      console.log(`  ${table_name.padEnd(22)} (error: ${e.message})`);
    }
  }

  try {
    const users = await client.query(
      `SELECT phone, role::text AS role, full_name, is_active,
              LEFT(password_hash, 7) || '...' AS password_hint
       FROM users ORDER BY phone`,
    );
    if (users.rows.length) {
      console.log('\n  users table:');
      console.table(users.rows);
    }
  } catch {
    // no users table
  }

  await client.end();
}

(async () => {
  for (const db of DATABASES) {
    await inspectDb(db);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

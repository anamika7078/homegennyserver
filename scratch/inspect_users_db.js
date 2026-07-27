const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres:root@localhost:5432/homegenny' });
c.connect()
  .then(async () => {
    const res = await c.query("SELECT id, phone, role, full_name, password_hash, is_active FROM users ORDER BY phone");
    console.log('Users in database:');
    console.log(JSON.stringify(res.rows, null, 2));
    await c.end();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

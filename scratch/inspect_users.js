const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres:root@localhost:5432/homegenny' });
c.connect()
  .then(async () => {
    const tables = await c.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    console.log('all tables', tables.rows.map((r) => r.table_name).join(', '));

    const cols = await c.query(
      "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position",
    );
    console.log('users columns', cols.rows);

    const enums = await c.query(
      "SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid=e.enumtypid WHERE t.typname LIKE '%role%' ORDER BY 1,2",
    );
    console.log('enums', enums.rows);

    await c.end();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

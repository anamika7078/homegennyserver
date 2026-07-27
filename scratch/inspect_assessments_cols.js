const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres:root@localhost:5432/homegenny' });
c.connect()
  .then(async () => {
    const cols = await c.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='assessments'",
    );
    console.log('assessments columns:', cols.rows);
    await c.end();
  })
  .catch(console.error);

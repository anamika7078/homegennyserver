const { Client } = require('pg');

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:hunesh@localhost:5432/homegenny?schema=public';

async function main() {
  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to Database.');

    // 1. Delete commercial items
    const resItems = await client.query(`DELETE FROM finance_commercial_items RETURNING id`);
    console.log(`Deleted ${resItems.rowCount} records from finance_commercial_items.`);

    // 2. Delete approvals linked to commercial calculations
    const resApprovals = await client.query(`DELETE FROM finance_approval RETURNING id`);
    console.log(`Deleted ${resApprovals.rowCount} records from finance_approval.`);

    // 3. Delete commercial calculation records
    const resCalcs = await client.query(`DELETE FROM finance_commercial_calculations RETURNING id, customer_name, unit_code`);
    console.log(`Deleted ${resCalcs.rowCount} records from finance_commercial_calculations:`);
    resCalcs.rows.forEach(r => console.log(`  - [${r.unit_code}] ${r.customer_name} (${r.id})`));

    console.log('\nAll commercial staff assignment calculation items have been deleted successfully!');
  } catch (err) {
    console.error('Error during deletion:', err);
  } finally {
    await client.end();
  }
}

main();

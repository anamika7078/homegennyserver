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

    // 1. Delete commercial calculation drafts
    const resCalcs = await client.query(`DELETE FROM finance_commercial_calculations RETURNING id`);
    console.log(`Deleted ${resCalcs.rowCount} records from finance_commercial_calculations.`);

    // 2. Delete customer branches
    const resBranches = await client.query(`DELETE FROM finance_customer_branches RETURNING id`);
    console.log(`Deleted ${resBranches.rowCount} records from finance_customer_branches.`);

    // 3. Delete finance customers
    const resCusts = await client.query(`DELETE FROM finance_customers RETURNING id, customer_name, unit_code`);
    console.log(`Deleted ${resCusts.rowCount} customer records from finance_customers:`);
    resCusts.rows.forEach(r => console.log(`  - [${r.unit_code}] ${r.customer_name} (${r.id})`));

    console.log('\nAll customer records and commercial calculations have been deleted successfully!');
  } catch (err) {
    console.error('Error during deletion:', err);
  } finally {
    await client.end();
  }
}

main();

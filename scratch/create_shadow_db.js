const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: 'postgresql://postgres:root@localhost:5432/postgres'
  });
  await client.connect();
  try {
    await client.query('CREATE DATABASE homegenny_shadow');
    console.log('Database homegenny_shadow created successfully');
  } catch (err) {
    if (err.code === '42P04') {
      console.log('Database homegenny_shadow already exists');
    } else {
      console.error(err);
    }
  } finally {
    await client.end();
  }
}

main();

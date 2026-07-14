const { Client } = require('pg');

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:root@localhost:5432/homegenny';

async function main() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('[OK] Connected to database');

  // Update existing staff codes to firstname+count format
  const updates = [
    // Trainer staff
    { oldCode: 'ST-DR-001', name: 'Amit Sharma',   newCode: 'amit001' },
    { oldCode: 'ST-SC-002', name: 'Sunita Kumar',  newCode: 'sunita001' },
    { oldCode: 'ST-UC-003', name: 'Rahul Verma',   newCode: 'rahul001' },
    { oldCode: 'ST-M3-004', name: 'Kavita Devi',   newCode: 'kavita001' },
    { oldCode: 'ST-DR-005', name: 'Vikram Singh',  newCode: 'vikram001' },
    // Finance staff
    { oldCode: 'FN-M3-101', name: 'Priya Nair',    newCode: 'priya001' },
    { oldCode: 'FN-DR-102', name: 'Ramesh Yadav',  newCode: 'ramesh001' },
    { oldCode: 'FN-SC-103', name: 'Lakshmi Iyer',  newCode: 'lakshmi001' },
    { oldCode: 'FN-UC-104', name: 'Geeta Sharma',  newCode: 'geeta001' },
  ];

  for (const u of updates) {
    const result = await client.query(
      `UPDATE staff_applicants SET staff_code = $1 WHERE staff_code = $2`,
      [u.newCode, u.oldCode]
    );
    if (result.rowCount > 0) {
      console.log(`✓ ${u.oldCode} → ${u.newCode} (${u.name})`);
    } else {
      console.log(`- ${u.oldCode} not found, skipping`);
    }
  }

  // Also update any other staff with old-format codes (HG-XX- or XX-XX- prefix)
  const { rows } = await client.query(
    `SELECT id, staff_code, full_name FROM staff_applicants WHERE staff_code LIKE '%-%' ORDER BY staff_code`
  );
  
  for (const row of rows) {
    const firstName = row.full_name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    // Find existing codes with this firstname prefix
    const { rows: existing } = await client.query(
      `SELECT staff_code FROM staff_applicants WHERE staff_code LIKE $1 ORDER BY staff_code DESC LIMIT 1`,
      [`${firstName}%`]
    );
    
    let seq = 1;
    if (existing.length > 0) {
      const match = existing[0].staff_code.match(/\d+$/);
      if (match) seq = parseInt(match[0], 10) + 1;
    }
    
    const newCode = `${firstName}${seq.toString().padStart(3, '0')}`;
    await client.query(
      `UPDATE staff_applicants SET staff_code = $1 WHERE id = $2`,
      [newCode, row.id]
    );
    console.log(`✓ ${row.staff_code} → ${newCode} (${row.full_name})`);
  }

  console.log('\n[DONE] All staff codes updated to firstname+count format');
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });

const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://homegenny_user:root@localhost:5432/homegenny' });
client.connect().then(async () => {
  const rmUser = await client.query("SELECT id, full_name, role, branch_id FROM users WHERE role = 'RM' LIMIT 1");
  console.log('RM User:', rmUser.rows[0]);

  const branchId = rmUser.rows[0]?.branch_id;

  const employees = await client.query(
    "SELECT id, employee_id, full_name, department, designation, status, branch_id, mobile, email, address, city, state, created_at, updated_at FROM employees WHERE deleted_at IS NULL AND (branch_id = $1 OR $1 IS NULL)",
    [branchId || null]
  );
  console.log('Mapped HR Employees for RM branch:', employees.rows.map(e => ({
    id: e.id,
    staff_code: e.employee_id,
    branch_id: e.branch_id,
    assigned_rm_id: rmUser.rows[0]?.id,
    series: e.department || 'GENERAL',
    series_db: e.department || 'GENERAL',
    role_types: [e.designation || e.department || 'STAFF'],
    language_tier: 'ENGLISH',
    pipeline_stage: e.status === 'Active' ? 'CONFIRMED' : e.status.toUpperCase(),
    current_scenario_code: null,
    terminal_outcome: null,
    full_name: e.full_name,
    mobile: e.mobile,
    email: e.email,
    address: `${e.address || ''}, ${e.city || ''}`.trim().replace(/^,/, ''),
    created_at: e.created_at,
    updated_at: e.updated_at,
    source: 'HR_EMPLOYEE',
  })));

  client.end();
}).catch(err => { console.error(err); client.end(); });

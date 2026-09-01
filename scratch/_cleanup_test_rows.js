const { Client } = require('pg');
require('dotenv').config();
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const emp = await c.query(
    "SELECT e.id, e.employee_id, e.staff_applicant_id FROM employees e JOIN staff_applicants sa ON sa.id = e.staff_applicant_id WHERE sa.staff_code = 'retest001'"
  );
  for (const r of emp.rows) {
    await c.query('DELETE FROM attendance WHERE employee_id = $1', [r.id]);
    await c.query("DELETE FROM audit_logs WHERE entity_id = $1 AND entity_type = 'employee'", [r.id]);
    await c.query('DELETE FROM staff_daily_attendance WHERE staff_id = $1', [r.staff_applicant_id]);
    await c.query('DELETE FROM shift_logs WHERE staff_id = $1', [r.staff_applicant_id]);
    await c.query('DELETE FROM employees WHERE id = $1', [r.id]);
    console.log('removed test employee', r.employee_id);
  }
  if (!emp.rows.length) console.log('nothing to clean');
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });

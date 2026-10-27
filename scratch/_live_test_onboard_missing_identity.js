// Live: onboarding a mobile-registered candidate (no address / DOB) must 400 with
// a clear message, and succeed once HR supplies them. Cleans up after itself.
const { Client } = require('pg');
require('dotenv').config();
const BASE = 'http://localhost:3001/api/v1';
let pass = 0, fail = 0;
const check = (l, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d ? ' :: ' + JSON.stringify(d) : ''}`); };
async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, body: j && j.success === true && 'data' in j ? j.data : j };
}
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  let token;
  for (const password of ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123', 'hr@1234']) {
    const r = await req('POST', '/auth/login', { body: { phone: '9800000008', password } });
    token = r.body?.access_token || r.body?.accessToken; if (token) break;
  }
  if (!token) { console.log('no HR login'); process.exit(1); }
  const { rows: [cand] } = await db.query(`SELECT id, staff_code, user_id FROM staff_applicants WHERE staff_code='kiran001'`);
  const cats = await db.query(`SELECT id FROM employee_categories LIMIT 1`);
  const base = { staffApplicantId: cand.id, department: 'Domestic Services', designation: 'Maid', categoryId: cats.rows[0].id, employmentType: 'Full Time', joiningDate: '2026-10-27', gender: 'Female' };

  const pend = await req('GET', '/employees/pending-onboarding?search=kiran001', { token });
  const item = (pend.body?.items || [])[0];
  check('pending list exposes address/dateOfBirth keys', item && 'address' in item && 'dateOfBirth' in item, item);

  const r1 = await req('POST', '/employees/onboard-from-pipeline', { token, body: base });
  check('missing address+DOB -> 400 (was 500)', r1.status === 400, r1);
  check('message names both fields', /address or date of birth/.test(JSON.stringify(r1.body)), r1.body?.message);

  const r2 = await req('POST', '/employees/onboard-from-pipeline', { token, body: { ...base, address: '12 Test Lane, Pune', dateOfBirth: 'not-a-date' } });
  check('invalid DOB -> 400', r2.status === 400, r2);

  const r3 = await req('POST', '/employees/onboard-from-pipeline', { token, body: { ...base, address: '12 Test Lane, Pune', dateOfBirth: '1992-05-14' } });
  check('with address+DOB -> 201', r3.status === 201, r3);
  const empId = r3.body?.employee?.id;
  if (empId) {
    const { rows: [e] } = await db.query(`SELECT address, to_char(date_of_birth,'YYYY-MM-DD') dob, staff_applicant_id FROM employees WHERE id=$1`, [empId]);
    check('DB address stored', e.address === '12 Test Lane, Pune', e);
    check('DB DOB stored as 1992-05-14', e.dob === '1992-05-14', e);
    // cleanup
    const linked = r3.body.linkedUserId;
    await db.query(`DELETE FROM audit_logs WHERE entity_id=$1 AND entity_type='employee'`, [empId]);
    await db.query(`DELETE FROM employees WHERE id=$1`, [empId]);
    if (linked && linked !== cand.user_id) {
      await db.query(`UPDATE staff_applicants SET user_id=$2 WHERE id=$1`, [cand.id, cand.user_id]);
      await db.query(`DELETE FROM users WHERE id=$1`, [linked]).catch((x) => console.log('  (user cleanup:', x.message, ')'));
    }
    const { rows: [after] } = await db.query(`SELECT count(*)::int n FROM employees WHERE staff_applicant_id=$1`, [cand.id]);
    check('cleanup: kiran001 back to un-onboarded', after.n === 0);
  }
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

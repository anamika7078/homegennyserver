/**
 * Live HTTP test for RM placements: wage_config pricing, rm/branch ownership,
 * scoping, Trial → A2/A3 → Confirm, Confirm Now, confirmed_at, and the rule
 * that a permanent placement is the staff's only one, and that a staff leaving
 * (TERMINAL, unless ENROLLED/CONDITIONAL) must be exited from placements first.
 * Builds its own staff and customers and removes them after.
 *
 *   node scratch/_live_test_rm_placement.js
 */
const { Client } = require('pg');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM = { phone: '9800000002', passwords: ['hg', 'HomeGenny@2024', 'Password@123'] };
const BRANCH = '00000000-0000-0000-0000-000000000001';

const WAGE_CONFIG = {
  basic_wage: 12000, da: 2000, hra: 1000, skilled_allowance: 0, working_hours: 8,
  pf_applicable: true, employer_pf_pct: 13, employer_pf_max: 15000, employee_pf_pct: 12,
  esic_applicable: true, employer_esic_pct: 3.25, employee_esic_pct: 0.75,
  bonus_applicable: true, bonus_pct: 8.33, bonus_frequency: 'monthly', leave_days: 32,
  lwf_applicable: true, lwf_amount: 62, uniform_applicable: true, uniform_allowance: 275,
  relieving_applicable: false, relieving_pct: 0, management_pct: 15, professional_tax: 200,
  gst_applicable: true, gst_type: 'intra_state', gst_pct: 18,
};

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

async function req(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json?.data !== undefined && json?.success !== undefined ? json.data : json, raw: json };
  }
}

async function login() {
  for (const password of RM.passwords) {
    const r = await req('POST', '/auth/login', { body: { phone: RM.phone, password } });
    const token = r.body?.access_token ?? r.body?.accessToken ?? r.raw?.access_token;
    if (token) return token;
  }
  throw new Error('RM login failed');
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const customers = [];
  let staffId = null;
  try {
    const token = await login();
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM.phone]);
    const mobile = '7' + String(Date.now()).slice(-9);
    ({ rows: [{ id: staffId }] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
         pipeline_stage, assigned_rm_id, branch_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'MAID', 'Placement Test', '1990-01-01', $2, 'Test', 'S5_DEPLOY', $3, $4, NOW())
       RETURNING id`,
      [`ZP-${Date.now() % 100000}`, mobile, rm.id, BRANCH],
    ));
    const a = await createCustomer(db, 'PlcA');
    const b = await createCustomer(db, 'PlcB');
    customers.push(a, b);

    console.log('\n── Trial, priced from wage_config, owned by the staff\'s RM and branch');
    let r = await req('POST', '/placements', {
      token, body: { staff_id: staffId, client_id: a.customerId, placement_type: 'PERMANENT', wage_config: WAGE_CONFIG, shift_hours: 8 },
    });
    check('create TRIAL with wage_config → 2xx', r.status < 300, r);
    const trial = r.body;
    check('salary and fee derived by the backend', Number(trial?.staff_salary) > 0 && Number(trial?.management_fee) > 0, trial);
    check('wage_breakup returned on the placement', !!trial?.wage_breakup?.totalCTC, trial?.wage_breakup);
    let { rows: [row] } = await db.query(`SELECT rm_id, branch_id, status::text, confirmed_at FROM placements WHERE id = $1`, [trial?.id]);
    check('rm_id = the staff\'s RM', row?.rm_id === rm.id, row);
    check('branch_id = the staff\'s branch', row?.branch_id === BRANCH, row);
    check('no confirmed_at on a trial', row?.confirmed_at === null, row);

    console.log('\n── RM sees their own trials');
    r = await req('GET', '/placements?status=TRIAL&limit=100', { token });
    const items = r.body?.items ?? [];
    check('status filter returns only TRIAL', items.length > 0 && items.every((p) => p.status === 'TRIAL'), items.map((p) => p.status));
    check('the new trial is in the RM\'s list', items.some((p) => p.id === trial?.id));
    const { rows: [own] } = await db.query(`SELECT count(*)::int AS n FROM placements WHERE rm_id = $1 AND status = 'TRIAL'`, [rm.id]);
    check('list is scoped to the RM', items.length === Math.min(own.n, 100), { listed: items.length, own: own.n });
    r = await req('GET', '/placements?status=BOGUS', { token });
    check('unknown status → 400', r.status === 400, r.status);

    console.log('\n── A permanent placement holds the staff');
    r = await req('POST', '/placements', {
      token, body: { staff_id: staffId, client_id: b.customerId, placement_type: 'PERMANENT', wage_config: WAGE_CONFIG },
    });
    check('second permanent placement at another client → 400', r.status === 400, r);
    check('message names the current client', String(r.raw?.message?.message ?? r.raw?.message ?? '').includes(a.customerName), r.raw?.message);
    r = await req('POST', '/placements', {
      token, body: { staff_id: staffId, client_id: b.customerId, placement_type: 'TEMPORARY', hourly_rate: 150, hourly_fee: 30 },
    });
    check('hourly placement elsewhere is refused too → 400', r.status === 400, r.status);

    console.log('\n── Trial → A2/A3 → Confirm');
    r = await req('POST', `/placements/${trial.id}/confirm`, { token });
    check('confirm without A2/A3 → 400', r.status === 400, r.status);
    r = await req('POST', '/sow', { token, body: { placement_id: trial.id, content: 'Cooking and cleaning, 8 hours.' } });
    check('SOW draft created', r.status < 300, r);
    r = await req('POST', `/sow/${r.body?.id}/send`, { token });
    check('SOW sent', r.status < 300, r);
    r = await req('POST', '/indemnity', { token, body: { placement_id: trial.id, clause_version: 'v1.0', clause_text: 'Standard clause.' } });
    check('indemnity sent', r.status < 300, r);
    r = await req('POST', `/placements/${trial.id}/confirm`, { token });
    check('confirm → 2xx', r.status < 300, r);
    ({ rows: [row] } = await db.query(`SELECT status::text, confirmed_at FROM placements WHERE id = $1`, [trial.id]));
    check('status CONFIRMED with confirmed_at set', row?.status === 'CONFIRMED' && row?.confirmed_at !== null, row);

    console.log('\n── Exit frees the staff; Confirm Now skips the trial');
    r = await req('POST', `/placements/${trial.id}/exit`, { token, body: { exit_date: new Date().toISOString().slice(0, 10), exit_scenario_code: 'MUTUAL' } });
    check('exit → 2xx', r.status < 300, r);
    r = await req('POST', '/placements', {
      token, body: { staff_id: staffId, client_id: b.customerId, placement_type: 'PERMANENT', wage_config: WAGE_CONFIG, status: 'CONFIRMED' },
    });
    check('Confirm Now at the other client after exit → 2xx', r.status < 300, r);
    ({ rows: [row] } = await db.query(`SELECT status::text, confirmed_at FROM placements WHERE id = $1`, [r.body?.id]));
    check('created CONFIRMED with confirmed_at set', row?.status === 'CONFIRMED' && row?.confirmed_at !== null, row);
    const liveId = r.body?.id;

    console.log('\n── A staff leaving can\'t leave active placements behind');
    r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'TERMINAL', terminal_outcome: 'ABANDONED' } });
    check('TERMINAL (ABANDONED) with an active placement → 400', r.status === 400, r.status);
    check('the 400 names the client', String(r.raw?.message?.message ?? r.raw?.message ?? '').includes(b.customerName), r.raw?.message);
    let { rows: [sa] } = await db.query(`SELECT pipeline_stage FROM staff_applicants WHERE id = $1`, [staffId]);
    check('stage unchanged', sa.pipeline_stage === 'S5_DEPLOY', sa);
    r = await req('POST', `/rm/pipeline/${staffId}/advance`, { token, body: { to_stage: 'TERMINAL', terminal_outcome: 'ENROLLED' } });
    check('TERMINAL (ENROLLED — a success) with an active placement → 2xx', r.status < 300, r);
    ({ rows: [row] } = await db.query(`SELECT status::text FROM placements WHERE id = $1`, [liveId]));
    check('the placement carries on', row?.status === 'CONFIRMED', row);
  } finally {
    if (staffId) {
      const { rows: pl } = await db.query(`SELECT id FROM placements WHERE staff_id = $1`, [staffId]);
      for (const { id } of pl) {
        for (const sql of [
          `DELETE FROM scope_of_work WHERE placement_id = $1`,
          `DELETE FROM client_indemnities WHERE placement_id = $1`,
          `DELETE FROM deployments WHERE placement_id = $1`,
          `DELETE FROM placements WHERE id = $1`,
        ]) await db.query(sql, [id]).catch((e) => console.log(`  (cleanup: ${e.message})`));
      }
      await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [staffId])
        .catch(() => db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = $1`, [staffId]));
    }
    for (const c of customers) await c.teardown().catch((e) => console.log(`  (cleanup customer: ${e.message})`));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

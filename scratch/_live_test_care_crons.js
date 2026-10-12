/**
 * The three scheduled jobs from Phases B–E, run for real against the database
 * (the app booted as a standalone context — they have no HTTP trigger):
 *
 *   CarePlanService.sweep()                 today's checklist made; overdue dose → MISSED; client + RM told once
 *   ClientUpdatesService.alertUnreadPlans() medicine change unread 2h+ → RM told once
 *   StaffRequestsService.alertSlaBreaches() request with no shortlist 24h+ → BM/Admin told once
 *
 * Needs `npx nest build` first (reads dist/).
 *
 *   node scratch/_live_test_care_crons.js
 */
const { Client } = require('pg');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const HQ = '00000000-0000-0000-0000-000000000001';
let pass = 0;
let fail = 0;
let skip = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}
const ist = () => new Date(Date.now() + 330 * 60_000);
const nowMin = () => ist().getUTCHours() * 60 + ist().getUTCMinutes();
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { CarePlanService } = require('../dist/modules/daily-care/care-plan.service');
  const { ClientUpdatesService } = require('../dist/modules/daily-care/client-updates.service');
  const { StaffRequestsService } = require('../dist/modules/staff-requests/staff-requests.service');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

  const made = { staff: null, placement: null, request: null };
  const cust = await createCustomer(db, 'Cron');
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = '9800000002'`);
    const { rows: [s] } = await db.query(
      `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, pipeline_stage, assigned_rm_id, branch_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'SKILLED_CARE', 'Cron Nurse', '1990-01-01', $2, 'x', 'S5_DEPLOY', $3, $4, NOW()) RETURNING id`,
      [`ZK-${Date.now() % 100000}`, '7' + String(Date.now()).slice(-9), rm.id, HQ],
    );
    made.staff = s.id;
    const { rows: [p] } = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours, trial_start_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', 'PERMANENT', 12, CURRENT_DATE, NOW(), NOW()) RETURNING id`,
      [s.id, cust.customerId, HQ, rm.id],
    );
    made.placement = p.id;
    const canMiss = nowMin() >= 3 * 60;
    const past = hhmm(Math.max(0, nowMin() - 120));
    const meds = [{ id: 'med-cron-1', name: 'Cronazole', dose: '1 tab', route: 'ORAL', times: canMiss ? [past, '23:59'] : ['23:59'], food_relation: 'ANY' }];
    // A plan written 3 hours ago with a medicine change nobody has read.
    const { rows: [plan] } = await db.query(
      `INSERT INTO care_plans (placement_id, client_id, version, status, medications, changes, created_at, metadata)
       VALUES ($1, $2, 1, 'ACTIVE', $3, '[{"type":"CREATED","text":"New care plan"}]', NOW() - INTERVAL '3 hours', '{"medical_change": true}')
       RETURNING id`,
      [p.id, cust.customerId, JSON.stringify(meds)],
    );

    console.log('\nsweep()');
    const care = app.get(CarePlanService);
    const r1 = await care.sweep();
    const { rows: tasks } = await db.query(`SELECT scheduled_time, status, notified_at FROM care_tasks WHERE placement_id = $1 ORDER BY scheduled_time`, [p.id]);
    check("today's checklist created by the sweep", tasks.length === (canMiss ? 2 : 1), tasks);
    if (canMiss) {
      check('the 2h-overdue dose is MISSED and marked notified', tasks[0].status === 'MISSED' && !!tasks[0].notified_at, tasks[0]);
      const { rows: n } = await db.query(`SELECT user_id FROM notifications WHERE template = 'CARE_DOSE_MISSED' AND payload->>'placement_id' = $1`, [p.id]);
      check('client and RM told', n.some((x) => x.user_id === cust.portalUserId) && n.some((x) => x.user_id === rm.id), n);
      await care.sweep();
      const { rows: n2 } = await db.query(`SELECT count(*)::int c FROM notifications WHERE template = 'CARE_DOSE_MISSED' AND payload->>'placement_id' = $1`, [p.id]);
      check('a second sweep does not tell them again', n2[0].c === n.length, n2[0].c);
    } else { skip++; console.log('  SKIP  missed-dose sweep (before 03:00 IST)'); }
    check('the later dose is still PENDING', tasks.at(-1).status === 'PENDING', tasks.at(-1));
    console.log(`        (${r1.plans} active plan(s) swept)`);

    console.log('\nalertUnreadPlans()');
    const updates = app.get(ClientUpdatesService);
    await updates.alertUnreadPlans();
    const { rows: u1 } = await db.query(`SELECT user_id FROM notifications WHERE template = 'CARE_PLAN_UNREAD' AND payload->>'plan_id' = $1`, [plan.id]);
    check('RM told the plan is unread after 2h', u1.length === 1 && u1[0].user_id === rm.id, u1);
    await updates.alertUnreadPlans();
    const { rows: u2 } = await db.query(`SELECT count(*)::int c FROM notifications WHERE template = 'CARE_PLAN_UNREAD' AND payload->>'plan_id' = $1`, [plan.id]);
    check('only once', u2[0].c === 1, u2[0].c);

    console.log('\nalertSlaBreaches()');
    const { rows: [sr] } = await db.query(
      `INSERT INTO staff_requests (request_no, client_id, branch_id, rm_id, source, series, status, created_at, requirements)
       VALUES ('SR-TEST-' || floor(random()*99999)::text, $1, $2, $3, 'CLIENT_APP', 'UNSKILLED_CARE', 'ASSIGNED', NOW() - INTERVAL '25 hours', '{}')
       RETURNING id`,
      [cust.customerId, HQ, rm.id],
    );
    made.request = sr.id;
    const sreq = app.get(StaffRequestsService);
    await sreq.alertSlaBreaches();
    const { rows: s1 } = await db.query(`SELECT user_id FROM notifications WHERE template = 'STAFF_REQUEST_SLA' AND payload->>'request_id' = $1`, [sr.id]);
    const { rows: bms } = await db.query(`SELECT id FROM users WHERE role = 'BM' AND is_active AND branch_id = $1`, [HQ]);
    check('HQ BM told about the 25h-old request', s1.length >= 1 && s1.every((x) => bms.some((b) => b.id === x.user_id)), { s1, bms });
    await sreq.alertSlaBreaches();
    const { rows: s2 } = await db.query(`SELECT count(*)::int c FROM notifications WHERE template = 'STAFF_REQUEST_SLA' AND payload->>'request_id' = $1`, [sr.id]);
    check('only once', s2[0].c === s1.length, s2[0].c);
  } finally {
    if (made.request) await db.query(`DELETE FROM staff_requests WHERE id = $1`, [made.request]).catch(() => {});
    if (made.placement) {
      await db.query(`DELETE FROM notifications WHERE payload->>'placement_id' = $1 OR payload->>'request_id' = $2`, [made.placement, made.request ?? '']).catch(() => {});
      await db.query(`DELETE FROM placements WHERE id = $1`, [made.placement]).catch((e) => console.log('  cleanup:', e.message));
    }
    if (made.staff) await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = $1`, [made.staff]).catch(() => {});
    await cust.teardown().catch((e) => console.log('  cleanup customer:', e.message));
    await app.close();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

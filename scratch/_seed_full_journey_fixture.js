/**
 * One staff member, all the way through — a fixture for testing Finance and HR.
 *
 * Builds the whole chain the business actually runs on:
 *
 *   staff_applicants (S1 → S5)  →  placement with a client
 *      →  30 days of attendance  →  payroll  →  one client invoice
 *      →  HR employee record, linked back to the pipeline row
 *
 * Every stage leaves the artefact it is supposed to leave — verification
 * tracks, an assessment, a video certification, a signed agreement, a scope of
 * work, a client indemnity — so the RM screens have something real to show, not
 * just a staff row with `pipeline_stage` set to S5.
 *
 * The client is a `finance_customers` row and the placement points at it
 * directly, because that is what consolidated invoicing joins on.
 *
 * LOCAL ONLY. Refuses to run against a remote database.
 * Re-running is safe: it purges its own rows first and rebuilds them.
 *
 *   node scratch/_seed_full_journey_fixture.js            (last month)
 *   node scratch/_seed_full_journey_fixture.js 8 2026     (a chosen period)
 */
const { Client } = require('pg');
require('dotenv').config();

const TAG = 'JOURNEY';
const STAFF_CODE = 'journey001';
const CLIENT_PREFIX = 'JOURNEY/BILL';
const STAFF_MOBILE = '9700000001';

const SALARY = 18000;
const FEE = 2000;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const host = new URL(url).hostname;
  if (!/localhost|127\.0\.0\.1/.test(host)) {
    console.error(`\nThis seeds test data and only runs against a local database.`);
    console.error(`DATABASE_URL points at ${host} — refusing.\n`);
    process.exit(1);
  }

  // Default to last month: attendance for a month still running would be
  // partial, and payroll for it is not something you would really run yet.
  const now = new Date();
  const argMonth = Number(process.argv[2]);
  const argYear = Number(process.argv[3]);
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const MONTH = argMonth || prev.getMonth() + 1;
  const YEAR = argYear || prev.getFullYear();
  const daysInMonth = new Date(YEAR, MONTH, 0).getDate();

  const c = new Client({ connectionString: url });
  await c.connect();

  try {
    await purge(c);

    const branch = (await c.query(`SELECT id, name FROM branches ORDER BY created_at LIMIT 1`)).rows[0];
    if (!branch) throw new Error('no branch in the database — seed users first');
    const rm = (await c.query(`SELECT id FROM users WHERE role = 'RM' LIMIT 1`)).rows[0];
    const hrUser = (await c.query(`SELECT id FROM users WHERE role = 'HR' LIMIT 1`)).rows[0];
    const category = (await c.query(`SELECT id FROM employee_categories LIMIT 1`)).rows[0];
    if (!category) throw new Error('no employee_categories row — cannot onboard an employee');

    await c.query('BEGIN');

    // ── the client ────────────────────────────────────────────────────────
    // Reused rather than recreated on a re-run: bill_seq is reset so invoice
    // numbering starts from 0001 again.
    const client = (await c.query(
      `INSERT INTO finance_customers
         (id, customer_name, bill_no_prefix, bill_seq, state, city, address,
          pan_card, gstn, unit_code, unit_name, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 0, 'Delhi', 'New Delhi',
               'B-42, Greater Kailash II, New Delhi 110048',
               'AAAPL1234C', '07AAAPL1234C1ZV', $3, $1, now())
       ON CONFLICT (unit_code) DO UPDATE
         SET customer_name = EXCLUDED.customer_name,
             bill_no_prefix = EXCLUDED.bill_no_prefix,
             bill_seq = 0, updated_at = now()
       RETURNING id`,
      [`${TAG} Test Household`, CLIENT_PREFIX, `${TAG}-UNIT-01`],
    )).rows[0];

    // ── the staff member, at the end of the pipeline ──────────────────────
    // Also reused: `pipeline_events` is append-only at the database level and
    // its FK to this row is RESTRICT, so once the fixture has a history the
    // row cannot be deleted — by design, and worth respecting rather than
    // working around.
    const staff = (await c.query(
      `INSERT INTO staff_applicants
         (id, staff_code, full_name, mobile, date_of_birth, address, series,
          pipeline_stage, branch_id, assigned_rm_id, aadhaar_number,
          deposit_amount, deposit_paid, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Sunita Devi', $2, '1992-03-14',
               'Sector 12, Dwarka, New Delhi', 'MAID', 'S5_DEPLOY', $3, $4,
               '999988887777', 5000, true, now(), now())
       ON CONFLICT (staff_code) DO UPDATE
         SET pipeline_stage = 'S5_DEPLOY', terminal_outcome = NULL,
             branch_id = EXCLUDED.branch_id, assigned_rm_id = EXCLUDED.assigned_rm_id,
             deposit_amount = 5000, deposit_paid = true, updated_at = now()
       RETURNING id`,
      [STAFF_CODE, STAFF_MOBILE, branch.id, rm?.id ?? null],
    )).rows[0];

    // S2 — every verification track cleared
    for (const track of ['AADHAAR_EKYC', 'POLICE_VERIFICATION', 'HEALTH_SCREENING', 'REFERENCE']) {
      await c.query(
        `INSERT INTO verification_tracks (id, staff_id, track_type, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2::"VerificationTrackType", 'CLEAR', now())`,
        [staff.id, track],
      );
    }

    // S2.5 — assessment passed
    await c.query(
      `INSERT INTO assessments (id, staff_id, result, status, created_at)
       VALUES (gen_random_uuid(), $1, 'PASS'::"AssessmentResult", 'COMPLETED', now())`,
      [staff.id],
    );

    // S3 — training video certified
    await c.query(
      `INSERT INTO video_certifications
         (id, staff_id, prompt_key, video_url, sha256_hash, review_status, created_at)
       VALUES (gen_random_uuid(), $1, 'INTRO_HINDI',
               'https://example.invalid/journey/intro.mp4',
               repeat('a', 64), 'APPROVED', now())`,
      [staff.id],
    );

    // S5 — the placement (created before the S4 artefacts, which reference it)
    const startDate = new Date(YEAR, MONTH - 1, 1);
    const placement = (await c.query(
      `INSERT INTO placements
         (id, staff_id, client_id, branch_id, rm_id, status,
          staff_salary, management_fee, confirmed_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'CONFIRMED', $5, $6, $7, now(), now())
       RETURNING id`,
      [staff.id, client.id, branch.id, rm?.id ?? null, SALARY, FEE, startDate],
    )).rows[0];

    // S4 — agreement signed, scope of work, client indemnity
    await c.query(
      `INSERT INTO agreements
         (id, staff_id, client_id, placement_id, type, status, otp_verified, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'PLACEMENT', 'SIGNED', true, now())`,
      [staff.id, client.id, placement.id],
    );
    await c.query(
      `INSERT INTO scope_of_work
         (id, placement_id, client_id, staff_id, content, status, created_by, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, 'ACTIVE', $5, now())`,
      [
        placement.id, client.id, staff.id,
        JSON.stringify({
          duties: ['Cooking', 'Cleaning', 'Laundry'],
          hours: '08:00–17:00',
          weeklyOff: 'Sunday',
        }),
        rm?.id ?? hrUser?.id ?? null,
      ],
    );
    await c.query(
      `INSERT INTO client_indemnities
         (id, placement_id, client_id, clause_version, clause_text, sent_by, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'v1.0',
               'The client indemnifies HomeGenny against claims arising from the placement.',
               $3, now())`,
      [placement.id, client.id, rm?.id ?? hrUser?.id ?? null],
    );

    // the trail the RM screens read
    const stages = [
      ['S1_INTAKE', 'STAGE_ENTERED'],
      ['S2_VERIFY', 'STAGE_ENTERED'],
      ['S2_5_ASSESS', 'STAGE_ENTERED'],
      ['S3_TRAIN', 'STAGE_ENTERED'],
      ['S4_AGREEMENTS', 'STAGE_ENTERED'],
      ['S5_DEPLOY', 'STAGE_ENTERED'],
    ];
    // Only on the first build — these cannot be deleted, so a re-run would
    // otherwise stack a second copy of the same journey onto the timeline.
    const haveEvents = await c.query(
      `SELECT 1 FROM pipeline_events WHERE staff_id = $1 LIMIT 1`, [staff.id],
    );
    if (!haveEvents.rowCount) {
      for (const [i, [stage, evt]] of stages.entries()) {
        await c.query(
          `INSERT INTO pipeline_events (id, staff_id, event_type, to_stage, notes, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3::pipeline_stage, $4, now() - ($5 || ' days')::interval)`,
          [staff.id, evt, stage, `${TAG} fixture — ${stage}`, String(stages.length - i + 30)],
        );
      }
    }

    // ── a full month of attendance ────────────────────────────────────────
    // Sundays off, one sick day, the rest present — a month that looks like a
    // real one rather than 30 identical rows.
    let present = 0, absent = 0, leave = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(YEAR, MONTH - 1, d);
      let status = 'PRESENT';
      if (date.getDay() === 0) status = 'LEAVE';
      else if (d === 17) status = 'ABSENT';

      if (status === 'PRESENT') present++;
      else if (status === 'ABSENT') absent++;
      else leave++;

      await c.query(
        `INSERT INTO staff_daily_attendance
           (id, staff_id, placement_id, branch_id, attendance_date, status,
            marked_by, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::staff_attendance_status, $6, now(), now())`,
        [
          staff.id, placement.id, branch.id,
          `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
          status, rm?.id ?? null,
        ],
      );

      // shift_logs too, so the other payroll route has something as well
      if (status === 'PRESENT') {
        await c.query(
          `INSERT INTO shift_logs (id, staff_id, placement_id, shift_date, status,
                                   check_in_at, check_out_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3::date, 'APPROVED',
                   $3::date + interval '8 hours',
                   $3::date + interval '17 hours', now(), now())
           ON CONFLICT DO NOTHING`,
          [staff.id, placement.id, `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(d).padStart(2, '0')}`],
        );
      }
    }

    // ── the HR employee, linked back to the pipeline row ──────────────────
    const employee = (await c.query(
      `INSERT INTO employees
         (id, employee_id, staff_applicant_id, full_name, mobile, date_of_birth,
          gender, address, city, state, pincode, emergency_contact, joining_date,
          branch_id, category_id, department, designation, employment_type,
          salary, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'Sunita Devi', $3, '1992-03-14',
               'Female', 'Sector 12, Dwarka, New Delhi', 'New Delhi', 'Delhi',
               '110075', '{}'::jsonb, $4, $5, $6, 'Field Operations',
               'Housemaid', 'Full Time', $7, 'Active', now(), now())
       RETURNING id, employee_id`,
      [
        `${TAG}001`, staff.id, STAFF_MOBILE,
        `${YEAR}-${String(MONTH).padStart(2, '0')}-01`,
        branch.id, category.id, SALARY,
      ],
    )).rows[0];

    await c.query('COMMIT');

    // ── what was made ─────────────────────────────────────────────────────
    const period = `${String(MONTH).padStart(2, '0')}/${YEAR}`;
    console.log(`\n  Fixture built for ${period}\n`);
    console.log(`  Client      ${TAG} Test Household     (bill prefix ${CLIENT_PREFIX})`);
    console.log(`  Staff       Sunita Devi  ·  ${STAFF_CODE}  ·  S5_DEPLOY`);
    console.log(`  Employee    ${employee.employee_id}  (linked to the pipeline row)`);
    console.log(`  Placement   CONFIRMED  ·  salary ₹${SALARY}  ·  fee ₹${FEE}`);
    console.log(`  Attendance  ${daysInMonth} days — ${present} present, ${leave} weekly off, ${absent} absent`);
    console.log(`  Pipeline    verification ×4 CLEAR, assessment PASS, video APPROVED,`);
    console.log(`              agreement SIGNED, scope of work, client indemnity`);
    console.log(`\n  Payroll and the invoice are deliberately NOT created — that is what`);
    console.log(`  you are here to test. Steps are in docs/TEST_FIXTURE_WALKTHROUGH.md\n`);
    console.log(`  Staff login   ${STAFF_MOBILE}`);
    console.log(`  Finance       9800000004 / HomeGenny@2024`);
    console.log(`  HR            9800000008 / HomeGenny@2024\n`);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nRolled back — nothing was created.');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

/** Remove everything this fixture creates, in FK-safe order. */
async function purge(c) {
  const staffSel = `SELECT id FROM staff_applicants WHERE staff_code = '${STAFF_CODE}'`;
  const clientSel = `SELECT id FROM finance_customers WHERE bill_no_prefix = '${CLIENT_PREFIX}'`;

  await c.query(`DELETE FROM invoice_items WHERE invoice_id IN (
                   SELECT id FROM client_invoices WHERE client_id IN (${clientSel}))`);
  await c.query(`UPDATE payroll_records SET client_invoice_id = NULL
                  WHERE client_invoice_id IN (
                    SELECT id FROM client_invoices WHERE client_id IN (${clientSel}))`);
  await c.query(`DELETE FROM client_invoices WHERE client_id IN (${clientSel})`);
  await c.query(`DELETE FROM payroll_records WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM employees WHERE staff_applicant_id IN (${staffSel})`);
  await c.query(`DELETE FROM staff_daily_attendance WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM shift_logs WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM scope_of_work WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM client_indemnities WHERE client_id IN (${clientSel})`);
  await c.query(`DELETE FROM agreements WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM placements WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM video_certifications WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM assessments WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM verification_tracks WHERE staff_id IN (${staffSel})`);
  await c.query(`DELETE FROM deposits WHERE staff_id IN (${staffSel})`);

  // staff_applicants and finance_customers are deliberately NOT deleted, and
  // neither is pipeline_events. That table is append-only — the database has a
  // trigger refusing UPDATE and DELETE — and its FK to staff_applicants is
  // RESTRICT, so the staff row cannot be removed once it has a history. Both
  // rows are upserted in place instead.
}

main();

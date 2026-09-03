/**
 * Live HTTP verification for §B1/§F2 of docs/HOURLY_MULTI_CLIENT_PLAN.md —
 * creating the two kinds of placement, and letting one person hold several.
 *
 * The API used to refuse any second active placement, which made a maid working
 * more than one house impossible to represent. It now refuses only a second
 * placement *with the same client*, and a placement declares how it is paid:
 * PERMANENT on a monthly salary, TEMPORARY on an hourly rate that can differ
 * from house to house.
 *
 * Creates its own staff and clients, then removes them.
 *
 *   node scratch/_live_test_f2_placement_type.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const RM_PHONE = '9800000002';
const PASSWORDS = ['HomeGenny@2024', 'Admin@123', 'Password@123'];

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 6) {
    const waitMs = 5000 * (attempt + 1);
    console.log(`      (rate limited, waiting ${waitMs / 1000}s…)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}

async function req(method, path, { token, body } = {}) {
  const res = await fetchWithBackoff(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  const payload =
    json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: payload };
}

async function login(phone) {
  for (const password of PASSWORDS) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    if (r.status === 200 || r.status === 201) {
      const t = r.body?.access_token || r.body?.accessToken;
      if (t) return t;
    }
  }
  throw new Error(`Could not log in as ${phone}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  const isLocal = /localhost|127\.0\.0\.1/.test(new URL(url).hostname);
  const db = new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });
  await db.connect();

  const made = { staffId: null, customerIds: [], placementIds: [] };

  try {
    const token = await login(RM_PHONE);
    check('RM can log in', !!token);

    const branch = await db.query(`SELECT id FROM branches LIMIT 1`);
    const branchId = branch.rows[0]?.id;
    if (!branchId) throw new Error('no branch in this database');

    const staff = await db.query(
      `INSERT INTO staff_applicants
         (id, staff_code, series, full_name, mobile, date_of_birth, address, branch_id,
          pipeline_stage, created_at, updated_at)
       VALUES (gen_random_uuid(), 'F2TYPE01', 'MAID', 'Type Test Wali', '9700000099',
               '1995-01-01', 'Test address', $1, 'S5_DEPLOY', now(), now()) RETURNING id`,
      [branchId],
    );
    made.staffId = staff.rows[0].id;

    // A third house she is not yet at, so the rate and type checks below are
    // reached instead of being short-circuited by the duplicate-client guard.
    for (const [code, name] of [
      ['F2-HOUSE-A', 'F2 House A'], ['F2-HOUSE-B', 'F2 House B'], ['F2-HOUSE-C', 'F2 House C'],
    ]) {
      await db.query(`DELETE FROM finance_customers WHERE unit_code = $1`, [code]);
      const c = await db.query(
        `INSERT INTO finance_customers
           (id, customer_name, unit_code, unit_name, address, pan_card, bill_no_prefix,
            status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $1, 'Somewhere', 'AAAPL7777C', $2,
                 'ACTIVE', now(), now()) RETURNING id`,
        [name, code],
      );
      made.customerIds.push(c.rows[0].id);
    }

    // ── a permanent placement ─────────────────────────────────────────────
    const perm = await req('POST', '/placements', {
      token,
      body: {
        staff_id: made.staffId, client_id: made.customerIds[0],
        placement_type: 'PERMANENT', staff_salary: 20000, management_fee: 3000, shift_hours: 12,
      },
    });
    check('a permanent placement is created', perm.status === 200 || perm.status === 201,
      { status: perm.status, body: perm.body });
    if (perm.body?.id) made.placementIds.push(perm.body.id);
    check('it comes back as PERMANENT', perm.body?.placement_type === 'PERMANENT',
      perm.body?.placement_type);
    check('its shift is kept', Number(perm.body?.shift_hours) === 12, perm.body?.shift_hours);

    // ── the same person, a different house, paid by the hour ──────────────
    const hourly = await req('POST', '/placements', {
      token,
      body: {
        staff_id: made.staffId, client_id: made.customerIds[1],
        placement_type: 'TEMPORARY', hourly_rate: 220, hourly_fee: 35,
      },
    });
    check('the same person can be placed at a second house',
      hourly.status === 200 || hourly.status === 201, { status: hourly.status, body: hourly.body });
    if (hourly.body?.id) made.placementIds.push(hourly.body.id);
    check('the second one is TEMPORARY', hourly.body?.placement_type === 'TEMPORARY',
      hourly.body?.placement_type);
    check('with its own hourly rate', Number(hourly.body?.hourly_rate) === 220,
      hourly.body?.hourly_rate);

    // ── but not twice at the same house ───────────────────────────────────
    const dupe = await req('POST', '/placements', {
      token,
      body: {
        staff_id: made.staffId, client_id: made.customerIds[0],
        placement_type: 'PERMANENT', staff_salary: 20000, management_fee: 3000,
      },
    });
    check('a second placement at the same house is refused', dupe.status === 400, dupe.status);

    // ── an hour with no price cannot be billed ────────────────────────────
    const noRate = await req('POST', '/placements', {
      token,
      body: {
        staff_id: made.staffId, client_id: made.customerIds[2],
        placement_type: 'TEMPORARY',
      },
    });
    check('a TEMPORARY placement without a rate is refused', noRate.status === 400, noRate.status);
    check('and the refusal explains why',
      /hourly_rate is required/i.test(JSON.stringify(noRate.body ?? '')), noRate.body);

    const badType = await req('POST', '/placements', {
      token,
      body: {
        staff_id: made.staffId, client_id: made.customerIds[2],
        placement_type: 'CASUAL', staff_salary: 100, management_fee: 10,
      },
    });
    check('an unknown placement type is refused', badType.status === 400, badType.status);

    // ── the list reports both, with their terms ───────────────────────────
    const list = await req('GET', `/placements?staff_id=${made.staffId}&limit=50`, { token });
    const mine = (list.body?.items ?? []).filter((p) => p.staff_id === made.staffId);
    check('both placements are listed', mine.length === 2, mine.length);
    check('the list says which kind each is',
      new Set(mine.map((p) => p.placement_type)).size === 2,
      mine.map((p) => p.placement_type));
    check('and carries the hourly rate through',
      Number(mine.find((p) => p.placement_type === 'TEMPORARY')?.hourly_rate) === 220,
      mine.map((p) => p.hourly_rate));
  } finally {
    try {
      if (made.staffId) {
        await db.query(`DELETE FROM deployments WHERE staff_id = $1`, [made.staffId]).catch(() => {});
        await db.query(`DELETE FROM placements WHERE staff_id = $1`, [made.staffId]);
        await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [made.staffId]);
      }
      if (made.customerIds.length) {
        await db.query(`DELETE FROM finance_customers WHERE id = ANY($1::uuid[])`, [made.customerIds]);
      }
      await db.query(`DELETE FROM staff_applicants WHERE staff_code = 'F2TYPE01'`);
      await db.query(`DELETE FROM finance_customers WHERE unit_code IN ('F2-HOUSE-A','F2-HOUSE-B','F2-HOUSE-C')`);
      console.log('\n  (fixture removed)');
    } catch (e) {
      console.log(`\n  CLEANUP WARNING: ${e.message}`);
    }
    await db.end();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

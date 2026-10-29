/**
 * Live HTTP verification of M2 — the Form XVI muster roll.
 *
 *  - the roll for a client and month: P / ½ / L / A / WO (weekly off on its
 *    weekday), overtime as additional hours, a disputed day left blank with a
 *    remark, a staff member who left mid-month; father's/husband's name, sex,
 *    rank; daily mandays and totals
 *  - printable HTML with the Form XVI header, contractor and principal employer;
 *    audit=1 adds the proof page
 *  - the client signs in the app: version 1, the month's waiting staff-app
 *    days confirmed; a correction after signing shows as a change
 *  - the RM uploads the signed paper roll: version 2, version 1 superseded,
 *    the scan downloads, waiting days become APPROVED_PAPER
 *
 * Uses March 2025 (2 March 2025 is a Sunday). Builds and removes its own rows.
 *
 *   node scratch/_live_test_muster_roll.js
 */
const { Client } = require('pg');
require('dotenv').config();
const { createCustomer } = require('./_fixtures');

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Admin@123', 'Password@123'];
let pass = 0, fail = 0;
const check = (l, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${!ok && d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 700) : ''}`); };
async function req(method, path, { token, body, form, raw } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (!form) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 429 && attempt < 8) { await new Promise((r) => setTimeout(r, 6000 * (attempt + 1))); continue; }
    if (raw) return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
    let j = null; try { j = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: j && j.success === true && 'data' in j ? j.data : j };
  }
}
async function login(phone, passwords = PASSWORDS) {
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password } });
    const t = r.body?.access_token || r.body?.accessToken; if (t) return t;
  }
  throw new Error(`no login for ${phone}`);
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const mar = (d) => `2025-03-${String(d).padStart(2, '0')}`;
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const made = { staff: [], placements: [] };
  let cust;
  try {
    const hr = await login('9800000008');
    const finance = await login('9800000004');
    const rm = await login('9800000002');
    const { rows: [rmUser] } = await db.query(`SELECT id FROM users WHERE phone = '9800000002'`);
    const branchId = (await db.query(`SELECT id FROM branches LIMIT 1`)).rows[0].id;
    cust = await createCustomer(db, 'Muster');
    const client = await login(cust.phone, [cust.password]);
    const C = cust.customerId;

    const staff = async (code, name, meta) => {
      const { rows: [s] } = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address, branch_id, metadata, updated_at)
         VALUES (gen_random_uuid(), $1, 'MAID', $2, '1990-01-01', $3, 'x', $4, $5::jsonb, NOW()) RETURNING id`,
        [code, name, `95${String(Date.now()).slice(-8)}`, branchId, JSON.stringify(meta)]);
      made.staff.push(s.id);
      return s.id;
    };
    const place = async (staffId, cols) => {
      const { rows: [p] } = await db.query(
        `INSERT INTO placements (id, staff_id, client_id, branch_id, rm_id, status, placement_type, shift_hours, staff_salary,
                                 management_fee, weekly_off_day, exit_date, trial_start_date, confirmed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'PERMANENT', 8, 15000, 1500, $6, $7, '2025-03-01', '2025-03-01', NOW(), NOW())
         RETURNING id`, [staffId, C, branchId, rmUser.id, cols.status ?? 'CONFIRMED', cols.wo ?? null, cols.exit ?? null]);
      made.placements.push(p.id);
      return p.id;
    };
    const A = await staff('MUS-A', 'Asha Muster', { father_or_husband_name: 'Ramesh Kumar', gender: 'FEMALE' });
    const B = await staff('MUS-B', 'Bina Muster', {});
    const pA = await place(A, { wo: 0 });                         // weekly off Sunday
    const pB = await place(B, { status: 'EXITED', exit: '2025-03-05' });
    const mark = async (sid, pid, d, status, source, cs, ot) => (await db.query(
      `INSERT INTO staff_daily_attendance (id, staff_id, placement_id, branch_id, attendance_date, status, overtime_hours, marked_by,
                                           source, client_status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING id`,
      [sid, pid, branchId, mar(d), status, ot ?? null, rmUser.id, source, cs])).rows[0].id;
    await mark(A, pA, 1, 'PRESENT', 'STAFF_APP', 'APPROVED');
    const waiting = [];
    for (const d of [3, 4, 5, 6, 7, 8]) waiting.push(await mark(A, pA, d, 'PRESENT', 'STAFF_APP', 'PENDING'));
    await mark(A, pA, 10, 'HALF_DAY', 'HR', 'NOT_REQUIRED');
    await mark(A, pA, 11, 'LEAVE', 'RM', 'NOT_REQUIRED');
    await mark(A, pA, 12, 'ABSENT', 'RM', 'NOT_REQUIRED');
    await mark(A, pA, 13, 'OVERTIME', 'RM', 'NOT_REQUIRED', 2);
    await mark(A, pA, 14, 'PRESENT', 'STAFF_APP', 'DISPUTED');
    for (const d of [1, 2, 3, 4, 5]) await mark(B, pB, d, 'PRESENT', 'RM', 'NOT_REQUIRED');

    // ── the client picker ───────────────────────────────────────────────
    let r = await req('GET', '/muster-rolls/clients?search=Muster', { token: finance });
    check('the client picker finds the client', ok2xx(r) && (Array.isArray(r.body) ? r.body : r.body?.data ?? []).some((c) => c.id === C), r.body);

    // ── the roll ────────────────────────────────────────────────────────
    r = await req('GET', `/muster-rolls?client_id=${C}&month=3&year=2025`, { token: hr });
    const roll = r.body;
    const ra = roll?.rows?.find((x) => x.code === 'MUS-A');
    const rb = roll?.rows?.find((x) => x.code === 'MUS-B');
    check('HR sees the roll: two staff, 31 days', ok2xx(r) && roll.rows.length === 2 && roll.days_in_month === 31, r.body);
    check('marks: P on 1st, WO on Sunday 2nd, ½ on 10th, L 11th, A 12th, P 13th',
      ra && ra.days[0] === 'P' && ra.days[1] === 'WO' && ra.days[9] === '½' && ra.days[10] === 'L' && ra.days[11] === 'A' && ra.days[12] === 'P', ra?.days);
    check('the disputed 14th is blank, with a remark', ra?.days[13] === '' && /1 day\(s\) under review/.test(ra?.remarks), ra);
    // 1 + 6 + 0.5 + 1 = 8.5 present; Sundays from the 2nd with nothing else recorded: 2, 9, 16, 23, 30 = 5
    check('Asha: 8.5 present, 2 additional hours, 5 weekly offs, total 13.5',
      ra?.days_present === 8.5 && ra?.additional_hours === 2 && ra?.weekly_off === 5 && ra?.total === 13.5, ra);
    check('father\'s/husband\'s name, sex and rank are on the row',
      ra?.father_or_husband_name === 'Ramesh Kumar' && ra?.sex === 'F' && ra?.rank, ra);
    check('Bina left on the 5th: 5 present, remark says so', rb?.days_present === 5 && /Left 2025-03-05/.test(rb?.remarks), rb);
    check('daily mandays: 2 on the 1st, 1 on the 2nd (Bina)', roll?.daily_mandays?.[0] === 2 && roll?.daily_mandays?.[1] === 1, roll?.daily_mandays?.slice(0, 5));
    check('totals add up', roll?.totals?.total_present === 13.5 && roll?.totals?.total_mandays === 18.5, roll?.totals);
    check('proof: staff-app days by status', roll?.proof?.PENDING === 6 && roll?.proof?.APPROVED === 1 && roll?.disputed_days === 1, roll?.proof);

    r = await req('GET', `/muster-rolls/print?client_id=${C}&month=3&year=2025&audit=1`, { token: finance, raw: true });
    check('Finance prints Form XVI', r.status === 200 && /FORM XVI/.test(r.text) && /Muster Roll/.test(r.text) && /DAILY MANDAYS/.test(r.text), r.status);
    check('…with contractor, principal employer and the proof page',
      /Name and address of Contractor/.test(r.text) && r.text.includes(cust.customerName) && /Attendance proof/.test(r.text), r.text.slice(0, 300));

    // ── the client signs ────────────────────────────────────────────────
    r = await req('GET', '/client/muster-rolls?month=3&year=2025', { token: client });
    check('client sees their roll, not yet signed', ok2xx(r) && r.body?.rows?.length === 2 && r.body?.signed === null, r.body?.signed);
    r = await req('POST', '/client/muster-rolls/sign', { token: client, body: { month: 3, year: 2025 } });
    check('signing needs a name', r.status === 400, r.body);
    r = await req('POST', '/client/muster-rolls/sign', { token: client, body: { month: 3, year: 2025, name: 'Mrs. Muster' } });
    check('client signs: version 1, the 6 waiting days confirmed', ok2xx(r) && r.body?.version === 1 && r.body?.days_confirmed === 6, r.body);
    const conf = (await db.query(`SELECT client_status FROM staff_daily_attendance WHERE id = ANY($1::uuid[])`, [waiting])).rows;
    check('…they are APPROVED now', conf.every((x) => x.client_status === 'APPROVED'), conf);
    r = await req('GET', `/muster-rolls?client_id=${C}&month=3&year=2025`, { token: rm });
    check('RM sees it signed in the app, nothing changed since',
      r.body?.signed?.status === 'SIGNED_DIGITAL' && r.body?.signed?.signed_name === 'Mrs. Muster' && r.body?.changed_since_signed?.length === 0, r.body?.signed);
    r = await req('GET', `/muster-rolls/print?client_id=${C}&month=3&year=2025`, { token: rm, raw: true });
    check('the print says who approved it', /Approved by <b>Mrs. Muster<\/b>/.test(r.text), r.status);

    // ── a correction after signing ──────────────────────────────────────
    await mark(A, pA, 20, 'PRESENT', 'RM', 'NOT_REQUIRED');
    const late = await mark(A, pA, 21, 'PRESENT', 'STAFF_APP', 'PENDING');
    r = await req('GET', `/muster-rolls?client_id=${C}&month=3&year=2025`, { token: rm });
    check('a day added after signing shows as a change', (r.body?.changed_since_signed ?? []).some((c) => /day 20: — → P/.test(c)), r.body?.changed_since_signed);
    r = await req('GET', `/muster-rolls/print?client_id=${C}&month=3&year=2025`, { token: rm, raw: true });
    check('…and the live print no longer claims the client approved it', !/Approved by/.test(r.text), r.status);

    // ── the RM uploads the signed paper roll ────────────────────────────
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'roll.png');
    form.append('client_id', C); form.append('month', '3'); form.append('year', '2025');
    form.append('signed_name', 'Mr. Muster'); form.append('note', 'Signed and stamped at the house');
    r = await req('POST', '/muster-rolls/upload', { token: hr, form });
    check('HR cannot upload the paper roll (403)', r.status === 403, r.status);
    const form2 = new FormData();
    form2.append('file', new Blob([PNG], { type: 'image/png' }), 'roll.png');
    form2.append('client_id', C); form2.append('month', '3'); form2.append('year', '2025');
    form2.append('signed_name', 'Mr. Muster'); form2.append('note', 'Signed and stamped at the house');
    r = await req('POST', '/muster-rolls/upload', { token: rm, form: form2 });
    check('RM uploads it: version 2, the late waiting day confirmed on paper', ok2xx(r) && r.body?.version === 2 && r.body?.days_confirmed === 1, r.body);
    const lateRow = (await db.query(`SELECT client_status FROM staff_daily_attendance WHERE id = $1`, [late])).rows[0];
    check('…as APPROVED_PAPER', lateRow.client_status === 'APPROVED_PAPER', lateRow);
    r = await req('GET', `/muster-rolls?client_id=${C}&month=3&year=2025`, { token: finance });
    const v = r.body?.versions ?? [];
    check('version 2 is current (paper), version 1 superseded',
      r.body?.signed?.version === 2 && r.body?.signed?.status === 'SIGNED_PAPER' && v.find((x) => x.version === 1)?.status === 'SUPERSEDED', v);
    const scan = await req('GET', `/muster-rolls/${r.body?.signed?.id}/scan`, { token: finance, raw: true });
    check('the scan downloads', scan.status === 200 && /image\/png/.test(scan.type ?? ''), scan.status);
    r = await req('GET', `/muster-rolls/print?client_id=${C}&month=3&year=2025&version=1`, { token: finance, raw: true });
    check('version 1 still prints as signed in the app', /Approved by <b>Mrs. Muster<\/b>/.test(r.text) && !/>P<\/td><td class="d">P/.test(''), r.status);
  } catch (e) {
    fail++; console.error('  ERROR', e.stack || e.message);
  } finally {
    if (cust) await db.query(`DELETE FROM muster_rolls WHERE client_id = $1`, [cust.customerId]);
    for (const sid of made.staff) await db.query(`DELETE FROM staff_daily_attendance WHERE staff_id = $1`, [sid]);
    for (const pid of made.placements) await db.query(`DELETE FROM placements WHERE id = $1`, [pid]);
    for (const sid of made.staff) await db.query(`DELETE FROM staff_applicants WHERE id = $1`, [sid]);
    if (cust) await cust.teardown();
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

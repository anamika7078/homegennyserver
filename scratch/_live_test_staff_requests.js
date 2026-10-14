/**
 * Live HTTP test for Phase B — staff requests (2026-10-12),
 * docs/CLIENT_REQUESTS_AND_DAILY_CARE_PLAN.md.
 *
 * Walks the whole thing as the client and the RM would:
 *   client raises → auto-assigned to the branch RM → candidates (series, holds,
 *   permanent-exclusive rule) → shortlist → client sees safe cards → client
 *   turns the shortlist down → RM shortlists again → client chooses →
 *   POST /placements with staff_request_id → FULFILLED.
 * Plus: validation, another client can't see it, a lead with no account
 * (unassigned → assigned → can't place → client attached), cancel, the
 * replacement → request conversion, and the SLA flag.
 *
 *   node scratch/_live_test_staff_requests.js
 */
const { Client } = require('pg');
const { createCustomer } = require('./_fixtures');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';
const PASSWORDS = ['hg', 'HomeGenny@2024', 'Password@123'];
const RM_PHONE = '9800000002';      // Pooja — the only RM in the HQ (New Delhi) branch
const ADMIN_PHONE = '9800000003';
const HQ = '00000000-0000-0000-0000-000000000001';
const PUNE = '00000000-0000-0000-0000-000000000002'; // no RM there

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
const msg = (r) => String(r.raw?.message?.message ?? r.raw?.message ?? '');
const ok2xx = (r) => r.status >= 200 && r.status < 300;

// Admin logins need 2FA; the code comes from the stored secret, as in the finance suites.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(encoded) {
  const cleaned = String(encoded).toUpperCase().replace(/=+$/, '').replace(/s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secret) {
  const { createHmac } = require('crypto');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

let DB = null;
async function login(phone, passwords = PASSWORDS) {
  const { rows: [u] } = await DB.query(`SELECT metadata FROM users WHERE phone = $1`, [phone]);
  const secret = (u?.metadata ?? {}).totp_secret ?? null;
  for (const password of passwords) {
    const r = await req('POST', '/auth/login', { body: { phone, password, ...(secret ? { totp: totpCode(secret) } : {}) } });
    const token = r.body?.access_token ?? r.body?.accessToken ?? r.raw?.access_token;
    if (token) return token;
  }
  throw new Error(`login failed for ${phone}`);
}

const uniqPhone = () => '5' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 10);
const inDays = (n) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

const UC_BODY = {
  series: 'UC',
  placement_type: 'PERMANENT',
  shift_hours: 12,
  start_date: inDays(3),
  start_time: '10:00',
  language: 'Hindi',
  gender_pref: 'ANY',
  // Budget is no longer asked for; sent anyway, it must be ignored.
  budget_min: 15000,
  budget_max: 20000,
  address: '22 Green Park, New Delhi',
  lat: 28.5592,
  lng: 77.2066,
  requirements: { patient_age: 78, mobility: 'ASSISTED', conditions: ['diabetes'], night_care: true },
  notes: 'Father needs help walking',
};

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  DB = db;
  const staffIds = [];
  const customers = [];
  const placementIds = [];
  const requestIds = [];
  let replacementId = null;
  try {
    const { rows: [rm] } = await db.query(`SELECT id FROM users WHERE phone = $1`, [RM_PHONE]);

    // ── fixtures ─────────────────────────────────────────────────────────────
    const cust = await createCustomer(db, 'SReq');
    const other = await createCustomer(db, 'SRqX');
    customers.push(cust, other);

    async function makeStaff(tag, { series = 'UNSKILLED_CARE', stage = 'S5_DEPLOY', gender = 'FEMALE' } = {}) {
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO staff_applicants (id, staff_code, series, full_name, date_of_birth, mobile, address,
           pipeline_stage, assigned_rm_id, branch_id, metadata, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '1990-01-01', $4, 'Secret Street 9', $5, $6, $7, $8, NOW())
         RETURNING id`,
        [`ZR-${tag}-${Date.now() % 100000}`, series, `${tag} Testwali Surname`, uniqPhone(), stage, rm.id, HQ, JSON.stringify({ gender })],
      );
      staffIds.push(id);
      return id;
    }
    const A = await makeStaff('Asha');                          // free, S5
    const B = await makeStaff('Bina');                          // permanently placed elsewhere
    const C = await makeStaff('Chitra');                        // open HOLD
    const D = await makeStaff('Durga', { stage: 'S4_AGREEMENTS' }); // S4: listed, not ready
    const E = await makeStaff('Esha', { series: 'SKILLED_CARE' });  // wrong series
    const F = await makeStaff('Fatima');                        // free, S5 — for the lead
    const { rows: [pb] } = await db.query(
      `INSERT INTO placements (id, staff_id, client_id, branch_id, status, placement_type, shift_hours, trial_start_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'CONFIRMED', 'PERMANENT', 8, CURRENT_DATE, NOW(), NOW()) RETURNING id`,
      [B, other.customerId, HQ],
    );
    placementIds.push(pb.id);
    await db.query(
      `INSERT INTO stage_holds (id, staff_id, stage, kind, reason, held_by, held_at)
       VALUES (gen_random_uuid(), $1, 'S5_DEPLOY', 'HOLD', 'OTHER', $2, NOW())`,
      [C, rm.id],
    );

    const rmToken = await login(RM_PHONE);
    const clientToken = await login(cust.phone, [cust.password]);
    const otherToken = await login(other.phone, [other.password]);

    // ── validation ───────────────────────────────────────────────────────────
    console.log('\nValidation (client)');
    const bad = async (label, body, re) => {
      const r = await req('POST', '/client/staff-requests', { token: clientToken, body });
      check(label, r.status === 400 && (!re || re.test(msg(r))), { status: r.status, msg: msg(r) });
    };
    await bad('MAID refused (paused series)', { ...UC_BODY, series: 'MAID' }, /not being taken on/i);
    await bad('UC asked for injections → told to ask for SC', { ...UC_BODY, requirements: { ...UC_BODY.requirements, medical_needs: ['INJECTION'] } }, /Skilled Caretaker/i);
    await bad('care request without mobility refused', { ...UC_BODY, requirements: { patient_age: 70 } }, /mobility/i);
    await bad('cook request without diet_type refused', { series: 'CK', start_date: inDays(3), start_time: '10:00', address: '22 Green Park, New Delhi', requirements: { family_size: 4, meals_per_day: ['LUNCH'] } }, /diet_type/i);
    await bad('start_date in the past refused', { ...UC_BODY, start_date: '2020-01-01' }, /past/i);
    const noAddr = { ...UC_BODY }; delete noAddr.address;
    await bad('address is required', noAddr, /address is required/i);
    await bad('lat without lng refused', { ...UC_BODY, lng: undefined }, /lat and lng together/i);
    await bad('start_date required', { ...UC_BODY, start_date: undefined }, /start_date is required/i);
    await bad('start_time required', { ...UC_BODY, start_time: undefined }, /start_time is required/i);
    await bad('start_time not HH:MM refused', { ...UC_BODY, start_time: '9am' }, /HH:MM/i);

    // ── create ───────────────────────────────────────────────────────────────
    console.log('\nClient raises a request');
    const created = await req('POST', '/client/staff-requests', { token: clientToken, body: UC_BODY });
    const sr = created.body;
    check('created (2xx)', ok2xx(created), { status: created.status, msg: msg(created) });
    if (!sr?.id) throw new Error('cannot continue without a request');
    requestIds.push(sr.id);
    check('request_no looks like SR-YYYY-NNNN', /^SR-\d{4}-\d{4,}$/.test(sr.request_no), sr.request_no);
    const { rows: [{ rm_id: assignedRm }] } = await db.query(`SELECT rm_id FROM staff_requests WHERE id = $1`, [sr.id]);
    check('auto-assigned to the HQ RM (New Delhi client)', sr.status === 'ASSIGNED' && assignedRm === rm.id, { status: sr.status, assignedRm });
    check('client gets the client view (no client_id, branch, SLA)', sr.client_id === undefined && sr.branch_id === undefined && sr.sla_breached === undefined, Object.keys(sr));
    check('…but does see who their RM is', !!sr.rm?.name && !!sr.rm?.phone, sr.rm);
    check('series stored as UNSKILLED_CARE, shown as UC', sr.series_db === 'UNSKILLED_CARE' && sr.series === 'UC');
    check('address is the one the client gave (not the account default)', sr.address === '22 Green Park, New Delhi', sr.address);
    check('budget not stored or returned', sr.budget_min === undefined && sr.budget_max === undefined, Object.keys(sr));
    const { rows: [srRow] } = await db.query(`SELECT budget_min, start_time, lat::float, lng::float FROM staff_requests WHERE id = $1`, [sr.id]);
    check('budget column left empty', srRow.budget_min === null, srRow);
    check('pin stored', Math.abs(srRow.lat - 28.5592) < 1e-6 && Math.abs(srRow.lng - 77.2066) < 1e-6, srRow);
    const { rows: [home] } = await db.query(`SELECT lat::float, lng::float FROM finance_customers WHERE id = $1`, [cust.customerId]);
    check("first pin became the client's home", Math.abs(home.lat - 28.5592) < 1e-6, home);
    const timed = await req('POST', '/client/staff-requests', { token: clientToken, body: { ...UC_BODY, start_date: inDays(2), start_time: '09:30' } });
    check('start date + time accepted and returned', ok2xx(timed) && timed.body?.start_time === '09:30' && timed.body?.start_date === inDays(2), { status: timed.status, msg: msg(timed), t: timed.body?.start_time });
    if (timed.body?.id) requestIds.push(timed.body.id);
    check('requirements normalised (conditions upper-cased)', JSON.stringify(sr.requirements?.conditions) === '["DIABETES"]', sr.requirements);
    const { rows: rmNotes } = await db.query(`SELECT template FROM notifications WHERE user_id = $1 AND payload->>'request_id' = $2`, [rm.id, sr.id]);
    check('RM got an in-app notification', rmNotes.some((n) => n.template === 'STAFF_REQUEST_ASSIGNED'), rmNotes);

    const cook = await req('POST', '/client/staff-requests', {
      token: clientToken,
      body: { series: 'CK', start_date: inDays(3), start_time: '10:00', address: '22 Green Park, New Delhi', requirements: { diet_type: 'veg', family_size: 4, meals_per_day: ['lunch', 'dinner'], health_conditions: ['diabetic'] } },
    });
    check('cook request accepted', ok2xx(cook) && cook.body?.series === 'CK', { status: cook.status, msg: msg(cook) });
    if (cook.body?.id) requestIds.push(cook.body.id);

    const mine = await req('GET', '/client/staff-requests', { token: clientToken });
    check('client lists their 3 requests', mine.body?.total === 3, mine.body?.total);
    const theirs = await req('GET', `/client/staff-requests/${sr.id}`, { token: otherToken });
    check("another client can't open it (404)", theirs.status === 404, theirs.status);

    const queue = await req('GET', '/rm/staff-requests?open=true', { token: rmToken });
    const inQueue = queue.body?.items?.find((i) => i.id === sr.id);
    check('in the RM queue', !!inQueue, queue.body?.total);
    check('…with client name, not SLA-breached yet', inQueue?.client_name === cust.customerName && inQueue?.sla_breached === false, inQueue);

    // ── candidates ───────────────────────────────────────────────────────────
    console.log('\nCandidates');
    const cands = await req('GET', `/rm/staff-requests/${sr.id}/candidates`, { token: rmToken });
    const ids = (cands.body?.items ?? []).map((c) => c.staff.id);
    check('free S5 staff listed', ids.includes(A), ids.length);
    check('S4 staff listed but ready=false', cands.body?.items?.find((c) => c.staff.id === D)?.ready === false);
    check('permanently-placed staff left out (permanent request)', !ids.includes(B));
    check('staff with an open HOLD left out', !ids.includes(C));
    check('other series left out', !ids.includes(E));
    check('S5 ranked above S4', ids.indexOf(A) < ids.indexOf(D), { A: ids.indexOf(A), D: ids.indexOf(D) });

    // ── shortlist ────────────────────────────────────────────────────────────
    console.log('\nShortlist');
    const badSl = await req('POST', `/rm/staff-requests/${sr.id}/shortlist`, { token: rmToken, body: { staff_ids: [B] } });
    check('shortlisting an ineligible staff refused', badSl.status === 400, { status: badSl.status, msg: msg(badSl) });
    const sl = await req('POST', `/rm/staff-requests/${sr.id}/shortlist`, { token: rmToken, body: { staff_ids: [A, D], rm_note: 'Both speak Hindi' } });
    check('shortlisted 2 → SHORTLISTED', ok2xx(sl) && sl.body?.status === 'SHORTLISTED' && sl.body?.candidates?.length === 2, { status: sl.status, st: sl.body?.status, msg: msg(sl) });
    const { rows: cn } = await db.query(`SELECT template FROM notifications WHERE user_id = $1 AND payload->>'request_id' = $2`, [cust.portalUserId, sr.id]);
    check('client notified of the shortlist', cn.some((n) => n.template === 'STAFF_REQUEST_SHORTLISTED'), cn);

    const view = await req('GET', `/client/staff-requests/${sr.id}`, { token: clientToken });
    const card = view.body?.candidates?.find((c) => c.staff.id === A);
    check('client sees 2 cards', view.body?.candidates?.length === 2, view.body?.candidates?.length);
    check('card shows first name only', card?.staff?.first_name === 'Asha', card?.staff);
    const cardJson = JSON.stringify(view.body?.candidates ?? []);
    check('no phone, surname or address in client cards', !/Surname|Secret Street|"mobile"|"phone"/.test(cardJson), cardJson.slice(0, 200));

    // ── client says no, RM tries again, client chooses ──────────────────────
    console.log('\nClient choice');
    const noReason = await req('POST', `/client/staff-requests/${sr.id}/reject-shortlist`, { token: clientToken, body: {} });
    check('reject without a reason refused', noReason.status === 400, noReason.status);
    const rej = await req('POST', `/client/staff-requests/${sr.id}/reject-shortlist`, { token: clientToken, body: { reason: 'Want someone older' } });
    check('reject shortlist → back to ASSIGNED', ok2xx(rej) && rej.body?.status === 'ASSIGNED', { status: rej.status, st: rej.body?.status, msg: msg(rej) });
    const sl2 = await req('POST', `/rm/staff-requests/${sr.id}/shortlist`, { token: rmToken, body: { staff_ids: [A] } });
    check('RM re-proposes Asha → SHORTLISTED', ok2xx(sl2) && sl2.body?.status === 'SHORTLISTED', { status: sl2.status, msg: msg(sl2) });
    const selD = await req('POST', `/client/staff-requests/${sr.id}/select`, { token: clientToken, body: { staff_id: D } });
    check("can't choose someone already turned down", selD.status === 400, selD.status);
    const sel = await req('POST', `/client/staff-requests/${sr.id}/select`, { token: clientToken, body: { staff_id: A, note: 'Looks kind' } });
    check('client chooses Asha → CLIENT_SELECTED', ok2xx(sel) && sel.body?.status === 'CLIENT_SELECTED', { status: sel.status, st: sel.body?.status, msg: msg(sel) });

    // ── placement fulfils it ─────────────────────────────────────────────────
    console.log('\nPlacement');
    const wrongStaff = await req('POST', '/placements', { token: rmToken, body: { staff_id: D, client_id: cust.customerId, staff_request_id: sr.id } });
    check('placing a turned-down staff against the request refused', wrongStaff.status === 400, { status: wrongStaff.status, msg: msg(wrongStaff) });
    const wrongClient = await req('POST', '/placements', { token: rmToken, body: { staff_id: A, client_id: other.customerId, staff_request_id: sr.id } });
    check('placing for a different client refused', wrongClient.status === 400 && /different client/i.test(msg(wrongClient)), { status: wrongClient.status, msg: msg(wrongClient) });
    const pl = await req('POST', '/placements', { token: rmToken, body: { staff_id: A, client_id: cust.customerId, staff_request_id: sr.id } });
    const plId = pl.body?.id ?? pl.body?.placement?.id;
    check('placement created', ok2xx(pl) && !!plId, { status: pl.status, msg: msg(pl) });
    if (plId) {
      placementIds.push(plId);
      const { rows: [p] } = await db.query(`SELECT placement_type, shift_hours::text, metadata->>'staff_request_id' AS sr FROM placements WHERE id = $1`, [plId]);
      check('placement took the request terms (12h, PERMANENT)', p.placement_type === 'PERMANENT' && Number(p.shift_hours) === 12, p);
      check('placement remembers the request', p.sr === sr.id, p.sr);
      const after = await req('GET', `/rm/staff-requests/${sr.id}`, { token: rmToken });
      check('request FULFILLED', after.body?.status === 'FULFILLED', after.body?.status);
      check('candidate PLACED with the placement id', after.body?.candidates?.find((c) => c.staff.id === A)?.placement_id === plId);
      const { rows: fn } = await db.query(`SELECT template FROM notifications WHERE user_id = $1 AND payload->>'request_id' = $2`, [cust.portalUserId, sr.id]);
      check('client told the booking is confirmed', fn.some((n) => n.template === 'STAFF_REQUEST_CONFIRMED'), fn);
      const late = await req('POST', `/rm/staff-requests/${sr.id}/shortlist`, { token: rmToken, body: { staff_ids: [D] } });
      check('a fulfilled request is closed to changes', late.status === 400, late.status);
    }

    // ── a lead with no account ───────────────────────────────────────────────
    console.log('\nLead (no client account)');
    const adminToken = await login(ADMIN_PHONE);
    const noWho = await req('POST', '/rm/staff-requests', { token: adminToken, body: { ...UC_BODY } });
    check('needs client_id or lead name + phone', noWho.status === 400, { status: noWho.status, msg: msg(noWho) });
    const lead = await req('POST', '/rm/staff-requests', {
      token: adminToken,
      body: { ...UC_BODY, lead_name: 'Mrs Lead', lead_phone: '9123456780', lead_city: 'Pune', branch_id: PUNE },
    });
    check('lead request created', ok2xx(lead), { status: lead.status, msg: msg(lead) });
    if (lead.body?.id) {
      requestIds.push(lead.body.id);
      check('Pune has no RM → NEW, unassigned', lead.body.status === 'NEW' && !lead.body.rm, { status: lead.body.status, rm: lead.body.rm });
      const { rows: an } = await db.query(`SELECT count(*)::int n FROM notifications WHERE template = 'STAFF_REQUEST_UNASSIGNED' AND payload->>'request_id' = $1`, [lead.body.id]);
      check('someone (BM or Admin) told it needs an RM', an[0].n > 0, an[0].n);
      const as = await req('PATCH', `/rm/staff-requests/${lead.body.id}/assign`, { token: adminToken, body: { rm_id: rm.id } });
      check('admin assigns an RM → ASSIGNED', ok2xx(as) && as.body?.status === 'ASSIGNED', { status: as.status, msg: msg(as) });
      const rmAssign = await req('PATCH', `/rm/staff-requests/${lead.body.id}/assign`, { token: rmToken, body: { rm_id: rm.id } });
      check('an RM cannot reassign', rmAssign.status === 403, rmAssign.status);
      const slLead = await req('POST', `/rm/staff-requests/${lead.body.id}/shortlist`, { token: rmToken, body: { staff_ids: [F] } });
      check('RM shortlists for the lead', ok2xx(slLead), { status: slLead.status, msg: msg(slLead) });
      const pLead = await req('POST', '/placements', { token: rmToken, body: { staff_id: F, client_id: cust.customerId, staff_request_id: lead.body.id } });
      check("can't place against a lead with no client", pLead.status === 400 && /lead/i.test(msg(pLead)), { status: pLead.status, msg: msg(pLead) });
      const att = await req('PATCH', `/rm/staff-requests/${lead.body.id}/client`, { token: rmToken, body: { client_id: other.customerId } });
      check('client attached to the lead', ok2xx(att) && att.body?.client?.id === other.customerId, { status: att.status, msg: msg(att) });
      const cx0 = await req('POST', `/rm/staff-requests/${lead.body.id}/cancel`, { token: rmToken, body: {} });
      check('cancel without a reason refused', cx0.status === 400, cx0.status);
      const cx = await req('POST', `/rm/staff-requests/${lead.body.id}/cancel`, { token: rmToken, body: { reason: 'Client went elsewhere' } });
      check('cancelled, shortlist withdrawn', ok2xx(cx) && cx.body?.status === 'CANCELLED' && cx.body?.candidates?.every((c) => c.status === 'WITHDRAWN'), { st: cx.body?.status, msg: msg(cx) });
    }

    // ── replacement → request ────────────────────────────────────────────────
    console.log('\nReplacement → staff request');
    if (plId) {
      const { rows: [rr] } = await db.query(
        `INSERT INTO replacement_requests (client_id, placement_id, staff_id, branch_id, rm_id, reason, raised_by)
         VALUES ($1, $2, $3, $4, $5, 'Often late', $6) RETURNING id`,
        [cust.customerId, plId, A, HQ, rm.id, cust.portalUserId],
      );
      replacementId = rr.id;
      const conv = await req('POST', `/rm/replacements/${rr.id}/convert`, {
        token: rmToken, body: { requirements: { patient_age: 78, mobility: 'ASSISTED' } },
      });
      check('converted', ok2xx(conv), { status: conv.status, msg: msg(conv) });
      if (conv.body?.id) {
        requestIds.push(conv.body.id);
        check('same series (UC), source REPLACEMENT, same RM', conv.body.series === 'UC' && conv.body.source === 'REPLACEMENT' && conv.body.rm?.id === rm.id, conv.body);
        const { rows: [rr2] } = await db.query(`SELECT status, resolution FROM replacement_requests WHERE id = $1`, [rr.id]);
        check('replacement marked APPROVED with the request number', rr2.status === 'APPROVED' && rr2.resolution.includes(conv.body.request_no), rr2);
      }
      const again = await req('POST', `/rm/replacements/${rr.id}/convert`, { token: rmToken, body: {} });
      check('converting twice refused', again.status === 400, again.status);
    }

    // ── SLA flag ─────────────────────────────────────────────────────────────
    console.log('\nSLA');
    if (cook.body?.id) {
      await db.query(`UPDATE staff_requests SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [cook.body.id]);
      const q2 = await req('GET', '/rm/staff-requests?open=true', { token: rmToken });
      check('a 25h-old request with no shortlist is sla_breached', q2.body?.items?.find((i) => i.id === cook.body.id)?.sla_breached === true);
    }
  } finally {
    if (requestIds.length) await db.query(`DELETE FROM staff_requests WHERE id = ANY($1::uuid[])`, [requestIds]).catch((e) => console.log('  cleanup requests:', e.message));
    if (replacementId) await db.query(`DELETE FROM replacement_requests WHERE id = $1`, [replacementId]).catch(() => {});
    for (const id of placementIds) {
      await db.query(`DELETE FROM deployments WHERE placement_id = $1`, [id]).catch(() => {});
      await db.query(`DELETE FROM placements WHERE id = $1`, [id]).catch((e) => console.log('  cleanup placement:', e.message));
    }
    await db.query(`DELETE FROM stage_holds WHERE staff_id = ANY($1::uuid[])`, [staffIds]).catch(() => {});
    await db.query(`UPDATE staff_applicants SET deleted_at = NOW() WHERE id = ANY($1::uuid[])`, [staffIds]).catch(() => {});
    for (const c of customers) await c.teardown().catch((e) => console.log('  cleanup customer:', e.message));
    await db.query(`DELETE FROM notifications WHERE template LIKE 'STAFF_REQUEST_%' AND payload->>'request_id' = ANY($1::text[])`, [requestIds]).catch(() => {});
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

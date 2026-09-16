/**
 * Live HTTP verification of the client-complaint / incident flow.
 *
 * The question this answers is the one a mobile dev actually has: can a CLIENT
 * login register a complaint, does it land as a real Incident row, and does it
 * reach the RM who has to act on it. The last part is the one that has been
 * quietly failing — a complaint that is written down but routed to nobody looks
 * identical to a working one from the client's side.
 *
 * Also walks the RM/BM side of the status machine (acknowledge -> escalate ->
 * resolve -> close) so the transition guards are exercised, not assumed.
 *
 * Everything it creates, it removes.
 *
 *   node scratch/_live_test_client_complaints.js
 */
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.env.TEST_BASE || 'http://localhost:3001/api/v1';

// Staff-side portal accounts come from the documented portal seed, so their
// password is known. The demo CLIENT logins were seeded elsewhere and theirs is
// not — pass one in rather than having this suite guess at credentials:
//
//   TEST_CLIENT_PHONE=9000555003 TEST_CLIENT_PASSWORD=... node scratch/_live_test_client_complaints.js
//
// Without it, sections [1]-[5] and [8] are skipped and the RM/BM half still runs.
const STAFF_PASSWORD = process.env.SEED_PASSWORD || 'hg';
const CLIENT_PHONE = process.env.TEST_CLIENT_PHONE || null;
const CLIENT_PASSWORD = process.env.TEST_CLIENT_PASSWORD || null;

let pass = 0, fail = 0;
const created = [];

function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}
function note(label, detail) {
  console.log(`  NOTE  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
}

async function fetchWithBackoff(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 8) {
    const waitMs = 5000 * (attempt + 1);
    console.log(`      (rate limited, waiting ${waitMs / 1000}s…)`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchWithBackoff(url, init, attempt + 1);
  }
  return res;
}

async function req(method, path, { token, body, form } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let payloadInit = {};
  if (form) {
    payloadInit = { body: form };                       // fetch sets the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payloadInit = { body: JSON.stringify(body) };
  }
  const res = await fetchWithBackoff(BASE + path, { method, headers, ...payloadInit });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  const unwrapped =
    json && typeof json === 'object' && json.success === true && 'data' in json ? json.data : json;
  return { status: res.status, body: unwrapped };
}
async function login(phone, password = STAFF_PASSWORD) {
  const r = await req('POST', '/auth/login', { body: { phone, password } });
  if (r.status === 200 || r.status === 201) {
    return r.body?.access_token || r.body?.accessToken || null;
  }
  return null;
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // ── pick a real client with an active placement ───────────────────────
    const clientRow = await db.query(`
      SELECT fc.id AS customer_id, fc.customer_name, u.phone,
             p.id AS placement_id, p.staff_id, p.rm_id, p.branch_id,
             sa.staff_code, sa.assigned_rm_id
      FROM finance_customers fc
      JOIN users u ON u.id = fc.user_id AND u.role = 'CLIENT' AND u.is_active = true
      JOIN placements p ON p.client_id = fc.id AND p.status IN ('CONFIRMED','TRIAL')
      JOIN staff_applicants sa ON sa.id = p.staff_id
      WHERE ($1::text IS NULL OR u.phone = $1)
      LIMIT 1
    `, [CLIENT_PHONE]);
    if (!clientRow.rows.length) { console.log('no client with an active placement — nothing to test'); return; }
    const C = clientRow.rows[0];
    console.log(`\nclient=${C.customer_name} (${C.phone})  staff=${C.staff_code}  placement=${C.placement_id}`);
    console.log(`placement.rm_id=${C.rm_id}   staff.assigned_rm_id=${C.assigned_rm_id}`);

    const clientToken = CLIENT_PASSWORD ? await login(C.phone, CLIENT_PASSWORD) : null;
    if (!CLIENT_PASSWORD) {
      note('no TEST_CLIENT_PASSWORD supplied — skipping the client-side sections', { phone: C.phone });
    } else {
      check('client can log in', !!clientToken);
    }

    // ── [1] the mobile-shaped multipart call ──────────────────────────────
    let ticket = null;
    console.log('\n[1] POST /client/complaints — the shape the Flutter app sends');
    if (clientToken) {
    const fd = new FormData();
    fd.append('subject', 'LIVETEST staff arrived 2 hours late');
    fd.append('description', 'LIVETEST filed by the client complaint live suite.');
    const filed = await req('POST', '/client/complaints', { token: clientToken, form: fd });
    check('multipart subject+description is accepted', filed.status === 200 || filed.status === 201, filed);
    ticket = filed.body?.ticketNumber;
    check('a ticketNumber comes back', !!ticket, filed.body);
    if (ticket) created.push(ticket);
    check('status is OPEN', filed.body?.status === 'OPEN', filed.body?.status);

    // ── [2] does the row actually exist, and is it routed ─────────────────
    console.log('\n[2] The row that was actually written');
    if (ticket) {
      const row = await db.query(
        `SELECT id, staff_id, client_id, placement_id, branch_id, rm_id, type, status, title, description, evidence_urls
         FROM incidents WHERE id = $1::uuid`, [ticket],
      );
      check('an incidents row exists', row.rows.length === 1);
      const I = row.rows[0] || {};
      check('client_id is set', I.client_id === C.customer_id, I.client_id);
      check('staff_id resolved from the active placement', I.staff_id === C.staff_id, I.staff_id);
      check('placement_id is set', !!I.placement_id, I.placement_id);
      check('type defaults to CLIENT_COMPLAINT', I.type === 'CLIENT_COMPLAINT', I.type);
      check('title falls back to subject', I.title === 'LIVETEST staff arrived 2 hours late', I.title);
      check('rm_id is set, so an RM inbox can find it', !!I.rm_id, { rm_id: I.rm_id, placement_rm_id: C.rm_id });
      check('branch_id is set', !!I.branch_id, I.branch_id);
    }

    // ── [3] does the client see it back ───────────────────────────────────
    console.log('\n[3] GET /client/complaints — client reads their own back');
    const mine = await req('GET', '/client/complaints', { token: clientToken });
    check('the list answers 200', mine.status === 200, mine.status);
    const list = mine.body?.complaints ?? [];
    check('the new complaint is in the list', list.some((x) => x.id === ticket || x.ticketNumber === ticket), { total: mine.body?.total });

    // ── [4] the JSON path (POST /incidents) ───────────────────────────────
    console.log('\n[4] POST /incidents — the JSON alternative');
    const json = await req('POST', '/incidents', {
      token: clientToken,
      body: { staff_id: C.staff_id, type: 'SCOPE_VIOLATION', title: 'LIVETEST scope violation', description: 'LIVETEST' },
    });
    check('JSON filing is accepted', json.status === 200 || json.status === 201, json);
    if (json.body?.id) created.push(json.body.id);

    // ── [5] ownership guard ───────────────────────────────────────────────
    console.log('\n[5] A client may only file against their own deployed staff');
    const foreign = await db.query(
      `SELECT id FROM staff_applicants WHERE id <> $1::uuid AND deleted_at IS NULL LIMIT 1`, [C.staff_id]);
    if (foreign.rows.length) {
      const bad = await req('POST', '/incidents', {
        token: clientToken,
        body: { staff_id: foreign.rows[0].id, type: 'CLIENT_COMPLAINT', title: 'LIVETEST should be refused' },
      });
      check('filing against someone else\'s staff is refused', bad.status === 403, bad.status);
      if (bad.body?.id) created.push(bad.body.id);
    }
    } // end client-token sections

    // ── [6] does it reach the RM ──────────────────────────────────────────
    console.log('\n[6] Does the complaint reach an RM queue?');
    const rmRow = await db.query(`SELECT phone FROM users WHERE id = $1::uuid`, [C.assigned_rm_id]);
    const rmToken = rmRow.rows.length ? await login(rmRow.rows[0].phone) : null;
    check('the assigned RM can log in', !!rmToken, rmRow.rows[0]?.phone);

    // If the client half was skipped, the RM raises one instead so the routing
    // and status-machine checks below still have something real to work on.
    if (rmToken && !ticket) {
      console.log('  (client half skipped — RM raises the incident via POST /rm/incidents instead)');
      const raised = await req('POST', '/rm/incidents', {
        token: rmToken,
        body: { staff_id: C.staff_id, type: 'CLIENT_COMPLAINT', title: 'LIVETEST raised by RM', description: 'LIVETEST' },
      });
      check('RM can raise an incident with a staff_id', raised.status === 200 || raised.status === 201, raised);
      ticket = raised.body?.id;
      if (ticket) created.push(ticket);
      const rr = await db.query(`SELECT rm_id, client_id, placement_id, branch_id, status FROM incidents WHERE id=$1::uuid`, [ticket]);
      check('the RM-raised row stores rm_id', !!rr.rows[0]?.rm_id, rr.rows[0]);
      check('status defaults to OPEN', rr.rows[0]?.status === 'OPEN', rr.rows[0]?.status);
      check('the RM-raised row is back-filled with the staff member\'s active engagement',
        !!rr.rows[0]?.client_id && !!rr.rows[0]?.placement_id, rr.rows[0]);
    }

    if (rmToken) {
      const rmInbox = await req('GET', '/rm/incidents', { token: rmToken });
      check('GET /rm/incidents answers', rmInbox.status === 200, rmInbox.status);
      const inbox = Array.isArray(rmInbox.body) ? rmInbox.body : (rmInbox.body?.items ?? []);
      check('the client complaint appears in the assigned RM\'s inbox',
        inbox.some((x) => x.id === ticket), { inboxSize: inbox.length });

      const rmIncidents = await req('GET', '/incidents', { token: rmToken });
      const inbox2 = Array.isArray(rmIncidents.body) ? rmIncidents.body : (rmIncidents.body?.items ?? []);
      check('the complaint appears in GET /incidents for that RM',
        inbox2.some((x) => x.id === ticket), { size: inbox2.length });
    }

    // ── [7] the status machine ────────────────────────────────────────────
    console.log('\n[7] Incident status transitions');
    if (ticket && rmToken) {
      const ack = await req('POST', `/incidents/${ticket}/acknowledge`, { token: rmToken });
      check('RM acknowledge: OPEN -> INVESTIGATING', ack.status === 200 || ack.status === 201, ack);
      const ackTwice = await req('POST', `/incidents/${ticket}/acknowledge`, { token: rmToken });
      check('acknowledging twice is refused', ackTwice.status === 400, ackTwice.status);

      const esc = await req('POST', `/incidents/${ticket}/escalate`, { token: rmToken });
      check('RM escalate: INVESTIGATING -> ESCALATED', esc.status === 200 || esc.status === 201, esc.status);

      // The BM dashboard and the 24-hour follow-up cron both read
      // escalation_logs; escalate() used to write nothing there.
      const escLog = await db.query(
        `SELECT id, status, severity, assigned_to FROM escalation_logs
         WHERE status='OPEN' AND metadata->>'incident_id' = $1`, [ticket]);
      check('escalating writes an OPEN escalation_logs row (BM dashboard + cron read it)',
        escLog.rows.length === 1, escLog.rows);
      check('the escalation row is assigned to the owning RM',
        !!escLog.rows[0]?.assigned_to, escLog.rows[0]);

      const noNote = await req('POST', `/incidents/${ticket}/resolve`, { token: rmToken, body: { resolution: '   ' } });
      check('resolving with a blank resolution note is refused', noNote.status === 400, noNote.status);

      const bmRow = await db.query(`SELECT phone FROM users WHERE role='BM' AND is_active=true LIMIT 1`);
      // BM uses the documented portal-seed password, same as the RM above.
      const bmToken = bmRow.rows.length ? await login(bmRow.rows[0].phone) : null;
      if (bmToken) {
        const bmList = await req('GET', '/incidents', { token: bmToken });
        const bmItems = Array.isArray(bmList.body) ? bmList.body : (bmList.body?.items ?? []);
        check('BM sees the escalated incident', bmItems.some((x) => x.id === ticket), { size: bmItems.length });
      }

      const res = await req('POST', `/incidents/${ticket}/resolve`, { token: rmToken, body: { resolution: 'LIVETEST resolved' } });
      check('RM resolve: ESCALATED -> RESOLVED', res.status === 200 || res.status === 201, res.status);

      const escAfter = await db.query(
        `SELECT status FROM escalation_logs WHERE metadata->>'incident_id' = $1`, [ticket]);
      check('resolving takes the escalation back out of the OPEN queue',
        escAfter.rows.every((r) => r.status !== 'OPEN'), escAfter.rows);

      const closeByRm = await req('POST', `/incidents/${ticket}/close`, { token: rmToken });
      check('RM cannot close (BM/Admin only)', closeByRm.status === 403, closeByRm.status);
      if (bmToken) {
        // BM's queue used to be ESCALATED-only, which made close() unreachable:
        // the only role that can close a RESOLVED incident could not see one.
        const bmQueue = await req('GET', '/incidents', { token: bmToken });
        const bmItems = Array.isArray(bmQueue.body) ? bmQueue.body : (bmQueue.body?.items ?? []);
        check('the RESOLVED incident is visible in the BM queue, so it can be closed',
          bmItems.some((x) => x.id === ticket), { size: bmItems.length });

        const closed = await req('POST', `/incidents/${ticket}/close`, { token: bmToken });
        check('BM close: RESOLVED -> CLOSED', closed.status === 200 || closed.status === 201, closed.status);
      }
    }

    // ── [8] the client cannot drive the workflow ──────────────────────────
    console.log('\n[8] Role gates on the client side');
    if (ticket && clientToken) {
      const clientAck = await req('POST', `/incidents/${ticket}/acknowledge`, { token: clientToken });
      check('a client cannot acknowledge', clientAck.status === 403, clientAck.status);
      const comment = await req('POST', `/incidents/${ticket}/comment`, { token: clientToken, body: { body: 'LIVETEST client follow-up' } });
      check('a client can comment on their own incident', comment.status === 200 || comment.status === 201, comment.status);
      const detail = await req('GET', `/incidents/${ticket}`, { token: clientToken });
      check('a client can read their own incident', detail.status === 200, detail.status);
      note('does the client detail payload expose the resolution text?', { resolution: detail.body?.resolution ?? null });
    }

    // ── [8b] the routing hole, proved without needing a client login ──────
    // fileByClient() copies rm_id off the placement. Every placement in this
    // database has rm_id NULL, so that is exactly the row a real client
    // complaint produces. Build that row and ask the RM's own inbox for it.
    console.log('\n[8b] A client-shaped complaint (rm_id NULL, as the placement has it)');
    const orphan = await db.query(
      // updated_at is written explicitly: Prisma's @updatedAt is ORM-only, the
      // column has no DB-level default, so a raw INSERT without it fails.
      `INSERT INTO incidents (id, staff_id, client_id, placement_id, branch_id, rm_id, type, status, title, evidence_urls, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'CLIENT_COMPLAINT', 'OPEN', 'LIVETEST client-shaped complaint', '{}', NOW(), NOW())
       RETURNING id`,
      [C.staff_id, C.customer_id, C.placement_id, C.branch_id, C.rm_id],
    );
    const orphanId = orphan.rows[0].id;
    created.push(orphanId);
    note('the row a real client complaint writes today', { rm_id: C.rm_id });

    if (rmToken) {
      const inbox = await req('GET', '/rm/incidents', { token: rmToken });
      const items = Array.isArray(inbox.body) ? inbox.body : (inbox.body?.items ?? []);
      // A row written with rm_id NULL is invisible to the RM — that is the read
      // side behaving correctly, and is exactly why the write side had to stop
      // producing NULLs. The fix is verified in [8c] below.
      check('a rm_id-NULL row is (still) invisible to the RM — read side unchanged',
        !items.some((x) => x.id === orphanId), { inboxSize: items.length });
    }

    // ── [8c] the write path now resolves an owning RM ─────────────────────
    // POST /rm/incidents used to set rmId = whoever typed it in. A BM raising
    // an incident therefore filed it into their own inbox, and the staff
    // member's actual RM — the person who has to work it — never saw it.
    console.log('\n[8c] Incident routing resolves to the staff member\'s assigned RM');
    const bmRow2 = await db.query(`SELECT id, phone FROM users WHERE role='BM' AND is_active=true LIMIT 1`);
    const bmToken2 = bmRow2.rows.length ? await login(bmRow2.rows[0].phone) : null;
    if (bmToken2) {
      const byBm = await req('POST', '/rm/incidents', {
        token: bmToken2,
        body: { staff_id: C.staff_id, type: 'SAFETY_ISSUE', title: 'LIVETEST raised by BM', description: 'LIVETEST' },
      });
      check('a BM can raise an incident', byBm.status === 200 || byBm.status === 201, byBm.status);
      if (byBm.body?.id) {
        created.push(byBm.body.id);
        const r = await db.query(`SELECT rm_id, client_id, placement_id, branch_id FROM incidents WHERE id=$1::uuid`, [byBm.body.id]);
        check('rm_id is the staff member\'s assigned RM, not the BM who typed it',
          r.rows[0]?.rm_id === C.assigned_rm_id, { got: r.rows[0]?.rm_id, bm: bmRow2.rows[0].id, expected: C.assigned_rm_id });
        check('client_id is back-filled from the active placement', r.rows[0]?.client_id === C.customer_id, r.rows[0]?.client_id);
        check('placement_id is back-filled', r.rows[0]?.placement_id === C.placement_id, r.rows[0]?.placement_id);

        if (rmToken) {
          const inbox = await req('GET', '/rm/incidents', { token: rmToken });
          const items = Array.isArray(inbox.body) ? inbox.body : (inbox.body?.items ?? []);
          check('the BM-raised incident lands in the assigned RM\'s inbox',
            items.some((x) => x.id === byBm.body.id), { inboxSize: items.length });
          check('list rows now carry the staff member',
            items.every((x) => !x.staffId || x.staff), items[0]);
        }
      }
    }

    // ── [9] what the pipeline thinks ──────────────────────────────────────
    console.log('\n[9] Side effects on the staff member');
    const staffAfter = await db.query(
      `SELECT pipeline_stage, terminal_outcome, current_scenario FROM staff_applicants WHERE id = $1::uuid`, [C.staff_id]);
    note('staff pipeline_stage after a filed + escalated complaint', staffAfter.rows[0]);

  } catch (err) {
    // Without this the process.exit() below swallows the stack entirely and the
    // run reports all-green with sections silently missing.
    fail++;
    console.log(`\n  ERROR  the suite threw: ${err.message}\n${err.stack}`);
  } finally {
    if (created.length) {
      await db.query(`DELETE FROM escalation_logs WHERE metadata->>'incident_id' = ANY($1::text[])`, [created]);
      await db.query(`DELETE FROM incident_comments WHERE incident_id = ANY($1::uuid[])`, [created]);
      await db.query(`DELETE FROM incidents WHERE id = ANY($1::uuid[])`, [created]);
      console.log(`\ncleaned up ${created.length} incident row(s)`);
    }
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

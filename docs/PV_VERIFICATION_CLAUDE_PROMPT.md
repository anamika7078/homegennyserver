# HomeGenny — RM Mobile App: Police Verification (PV) Flow

You are working on the **HomeGenny Flutter mobile application**, specifically the Police
Verification (PV / Pillar 4) sub-flow inside the existing S2_VERIFY stage screen.

Do NOT redesign existing UI unless a small modification is required to make this flow functional.
Inspect the existing Verification screen/repository/API service first — reuse it, don't duplicate it.

---

## 1. Where this fits

PV is one of 5 verification tracks under `S2_VERIFY` (aadhaar, dl, echallan, pv, medical). This
prompt covers only PV — assume the other 4 are already wired per `RM_CLAUDE_PROMPT.md` §12.

PV is **not just an S2 checklist item** — the value it ultimately writes is also the single field
`checkDeploymentEligibility()` reads at **S5_DEPLOY** to decide if a candidate can be deployed at
all (`pv_status !== 'CLEAR'` blocks deployment for every series except MAID, which only blocks on
`ADVERSE`). Getting this flow right matters beyond just the S2 screen.

---

## 2. Real APIs (all three now real and working — no known gaps)

**Submit a PV request:**
```
POST /verification/pv/submit/:staffId
Roles: RM, ADMIN
Body: { "notes": "Submitted at local police station" }
```
Creates/updates a `VerificationTrack` row (`trackType: POLICE_VERIFICATION`) with
`status: 'PENDING'`. Returns:
```json
{ "reference_number": "PV-XXXXXXXX-<ts>", "status": "PENDING", "submitted_at": "..." }
```
Calling it again on the same staff simply resubmits (overwrites the PENDING record) — safe to
retry, does not error.

**Read current status:**
```
GET /verification/:staffId
Roles: RM, ADMIN
```
Returns all 5 tracks for this staff, including the PV one (`status`: `NOT_STARTED` / `PENDING` /
`CLEAR` / `FAILED`).

**Close a submitted PV request with a real result** (this is the endpoint that was missing — now
built and live-tested):
```
POST /verification/pv/:staffId/close
Roles: RM, BM, ADMIN
Body: { "result": "CLEAR" | "ADVERSE", "notes": "Certificate received from local police station" }
```
Requires a prior `submit` to exist for this staff — returns `400 "PV was never submitted for this
staff"` otherwise. On success, atomically updates **both** the `VerificationTrack` row (visible via
`GET /verification/:staffId`) **and** `StaffApplicant.pv_status` (the field the S5_DEPLOY gate
actually reads, visible via `GET /staff/:staffId`) — these two used to be able to drift apart; now
they can't. Returns:
```json
{ "staff_id": "...", "pv_status": "CLEAR", "track_status": "CLEAR", "closed_at": "..." }
```
Rejects any `result` value other than exactly `CLEAR`/`ADVERSE` with a `400`.

---

## 3. UI states to implement

```
NOT_INITIATED  → "Not started" + Submit button
PENDING        → "Submitted <date>, ref <number> — awaiting result" + (RM/BM) "Record Result" action
CLEAR          → "Cleared" (green) — read-only
ADVERSE        → "Failed / Adverse" (red) — read-only, explain deployment is blocked
```

Pull the value from `GET /verification/:staffId`'s `pv` track for the S2-screen display. The
"Record Result" action (calling `close`) should be a clearly separate, deliberate action from
Submit — gate it so it's only reachable once a submission exists and is still PENDING, and require
the RM/BM to explicitly pick CLEAR or ADVERSE (no default selection) plus optional notes before
enabling the confirm button. This is a real compliance decision — do not make it a casual tap.

After a successful `close`, refresh both the verification-status call and the staff detail call so
the S2 screen and any S5-readiness indicator elsewhere in the app stay in sync.

---

## 4. Series exception — don't miss this

For `MAID` series specifically, a PENDING PV does **not** block deployment — only an `ADVERSE`
result does (`checkDeploymentEligibility()` special-cases this). Every other series requires
`CLEAR` explicitly. Reflect this in the UI copy/state (e.g. don't show a scary "blocked" warning
for a MAID candidate whose PV is merely PENDING).

---

## 5. Error handling / states

Same standard as the rest of the RM app (`RM_CLAUDE_PROMPT.md` §33/34): loading, empty, error,
retry, disable-while-submitting, no silent failures, no locally-inferred success before the API
confirms it. Specifically for `close`: if it 400s because no submission exists yet, surface that
message directly (it's already human-readable) rather than a generic error.

---

## 6. Final deliverable

Report back:
- Submit screen: wired / not wired.
- Status display: wired / not wired, reflecting the real `pv` track status.
- Record Result (close) action: wired / not wired, gated behind an explicit PENDING state and a
  deliberate CLEAR/ADVERSE choice (never defaulted or auto-triggered).
- Confirm the S2 screen and S5-readiness view both refresh from the server after a close call
  rather than assuming local state.

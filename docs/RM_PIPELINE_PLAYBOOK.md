# RM Pipeline Playbook

Every stage a staff record moves through (S1 → S5), the exact API each stage calls, and who is
allowed to trigger it. Written for wiring the RM side of the mobile app against the real backend.

> Cross-links: for the full screen-by-screen RM build plan see
> [`RM_MOBILE_APP_INTEGRATION_PLAN.md`](./RM_MOBILE_APP_INTEGRATION_PLAN.md); for the underlying
> product spec and where it disagrees with what's actually built see
> [`PRODUCT_SPEC_REFERENCE.md`](./PRODUCT_SPEC_REFERENCE.md); for the general mobile API reference
> (Auth/Staff/Client) see [`MOBILE_API_REFERENCE.md`](./MOBILE_API_REFERENCE.md).

## Environment

- **Base URL**: `https://homegennyserver-po5u.onrender.com/api/v1`
- **Auth**: `Authorization: Bearer <jwt>` from `POST /auth/login`
- **Response envelope**: `{ success, data, timestamp }`
- **RM demo login**: `9800000002` / `HomeGenny@2024`

## Roles at a glance

| Role | What they actually do in this pipeline |
|---|---|
| **RM** | Runs the whole pipeline day to day — intake, verification review, advancing stages, agreements, placement, attendance approval, invoicing. Can advance one stage at a time, or move fast once real prerequisites are met — see [RM's authority](#rms-authority-end-to-end). |
| **TRAINER** | Owns S3 training only — reviews video certifications and practical assessments. RM cannot approve a video certification; only Trainer/Admin can. See [Trainer's role](#trainers-role-specifically). |
| **BM** | Escalation/oversight — approves non-standard SOWs, reviews contested indemnity clauses, sees everything RM sees across branches. |
| **ADMIN** | Full access everywhere, including Trainer-only and BM-only actions. |
| **STAFF** | Their own record only — profile, check-in/check-out, own verification/pipeline status. |
| **CLIENT** | Their own placement(s) only — assigned staff, attendance, invoices, SOW/indemnity acknowledgement. |
| **FINANCE** | Payroll and invoicing, cross-staff — not part of the day-to-day pipeline flow. |

## Trainer's role, specifically

Trainer is a real, separate login (own JWT role, own controller) — not something RM does on their
behalf. Its job is narrow and sits entirely inside S3_TRAIN:

| Method | Route | Notes |
|---|---|---|
| GET | `/trainer/dashboard` | Their own stats — batches, pending reviews. |
| GET | `/trainer/batches` | Training batches assigned to this trainer. |
| GET | `/trainer/video-certifications` | List of video-cert submissions (branch-scoped), any status. Added because the review action below existed with no way to discover which ids needed reviewing — the web app's Trainer video-cert page always showed empty before this. |
| PUT | `/trainer/assessment/:traineeId` | Records/updates a trainee's in-class assessment score. Separate from the S2.5 driver practical test (`/assessments`), which RM/Admin runs. |
| PUT | `/trainer/video-certifications/:id/review` | **The real gate.** `{ status: "APPROVED" \| "REJECTED", notes? }` — this is the only way a video-cert prompt clears. It's what `checkDeploymentEligibility` counts against `REQUIRED_VIDEO_PROMPTS` before S5_DEPLOY is allowed. |
| POST | `/agreements/video-cert/:staffId/lock` | Trainer (or BM/Admin) locks the staff's approved video-cert set once training is done, ahead of moving into S4_AGREEMENTS. |

Everything else — advancing `pipeline_stage`, agreements, placement — stays with RM/Admin. Trainer
never touches `/rm/pipeline/*`.

## S1 — Intake

Staff record is created and screened against the restricted list in the same call.

| Method | Route | Notes |
|---|---|---|
| POST | `/rm/intake` | Creates the `StaffApplicant`. Restricted-list check runs inline. `advance_to_verify: true` (default) auto-moves it straight to S2_VERIFY. Body: `{ aadhaar_number, mobile, full_name, date_of_birth, address, series, deposit_amount?, advance_to_verify? }` |

## S2 — Verify

Five verification tracks — only the ones the series actually requires need to clear.

| Method | Route | Applies to |
|---|---|---|
| POST | `/verification/aadhaar` | All series |
| POST | `/verification/dl` | DR only — driving licence |
| POST | `/verification/echallan/:dlNumber` | DR only |
| POST | `/verification/pv/submit/:staffId` | All series — police verification |
| POST | `/verification/medical/submit/:staffId` | DR + SC + UC — not Maid |
| GET | `/verification/:staffId` | Aggregate status — every required track for this staff's series, plus `all_required_clear` |

Advance once all required tracks are clear:

```
POST /rm/pipeline/:staffId/advance
{ "to_stage": "S2_5_ASSESS" }   // DR only
{ "to_stage": "S3_TRAIN" }      // SC / UC / Maid — S2.5 is skipped
```

## S2.5 — Assess (DR only)

Driver practical road test.

| Method | Route | Notes |
|---|---|---|
| POST | `/assessments/create` | Body key is `staff_id` (snake_case) — not `staffId`. |
| POST | `/assessments/submit` | `{ result: "PASS" \| "FAIL" }` |

```
POST /rm/pipeline/:staffId/advance
{ "to_stage": "S3_TRAIN" }                                // on PASS
{ "to_stage": "TERMINAL", "terminal_outcome": "DENIED" }  // after 3 FAILs
```

## S3 — Train

Video-prompt training and certification. Upload is RM/staff-driven; approval is Trainer-only.

| Method | Route | Notes |
|---|---|---|
| GET | `/video-cert/prompts/:series` | Prompt list for this series |
| POST | `/video-cert/upload-url` | Signed URL — the video file uploads directly to it |
| POST | `/video-cert/finalize` | Hash-verifies and permanently saves the upload |

> **Gate**: RM cannot approve a video cert. Approval only happens via
> `PUT /trainer/video-certifications/:id/review` (see [Trainer's role](#trainers-role-specifically)).
> RM just watches for the approval and then advances the stage.

```
POST /rm/pipeline/:staffId/advance
{ "to_stage": "S4_AGREEMENTS" }
```

## S4 — Agreements

Three documents, in order: A1 (employment agreement, e-signed), A2 (Scope of Work), A3 (Client
Indemnity).

**A1 — employment agreement**

| Method | Route | Notes |
|---|---|---|
| POST | `/agreements` | `{ staff_id, client_id, type: "A1" }` |
| POST | `/agreements/esign/send-otp` | |
| POST | `/agreements/esign/verify-otp` | |
| POST | `/agreements/:id/sign` | |
| POST | `/agreements/:id/generate-pdf` | |

**A2 — Scope of Work & A3 — Indemnity**

| Method | Route | Notes |
|---|---|---|
| POST | `/placements` | Create the `TRIAL` placement **right here**, as soon as A1 is signed — don't wait for S5. `{ staff_id, client_id }` |
| POST | `/sow` | `{ placement_id, content }` |
| POST | `/indemnity` | `{ placement_id, clause_version, clause_text }` |

> **Correction from an earlier pass of this doc**: A2/A3 needing a `placement_id` before a
> placement exists was flagged as a real architecture gap, and a schema fix (making
> `placement_id` nullable on `ScopeOfWork`/`ClientIndemnity`) was drafted for it. Live-testing
> disproved the premise — `POST /placements` has **no pipeline-stage gate at all**. Confirmed by
> creating a placement for a staff still sitting at S2_VERIFY; it succeeded, and a SOW created
> against that placement succeeded too. The schema change was reverted — it isn't needed. The
> actual fix is pure sequencing: create the placement (TRIAL) the moment A1 is signed, then A2/A3
> have a real `placement_id` to point at, all still inside S4. No code or DB change required.

```
POST /rm/pipeline/:staffId/advance
{ "to_stage": "S5_DEPLOY" }
```

Blocked with a `400` listing every unmet prerequisite unless: PV clear, required video prompts
Trainer-approved, at least one agreement `SIGNED`, medical clear (SC/UC/DR), and — DR only —
licence clear, eChallan checked, practical test passed.

## S5 — Deploy

Confirm the placement, then the ongoing day-to-day loop.

| Method | Route | Notes |
|---|---|---|
| POST | `/placements/:id/confirm` | TRIAL → CONFIRMED. Required before check-in, attendance approval, or invoicing work for this placement. |

**Daily loop**

| Method | Route | Notes |
|---|---|---|
| POST | `/staff/attendance/check-in` | Staff-side |
| POST | `/staff/attendance/check-out` | Staff-side |
| PATCH | `/rm/shifts/:id/review` | RM approves/rejects the shift. An `APPROVED` review now auto-upserts the matching `StaffDailyAttendance` row (billable day) — a reversal (reject/flag) removes it again. Live-verified: approving a shift took `present_days` on the invoice preview from 0 → 1. |
| GET | `/rm/attendance/:staffId/invoice-preview?month=&year=` | |
| POST | `/rm/attendance/:staffId/generate-invoice` | |

## RM's authority, end to end

RM can advance one stage at a time via `/rm/pipeline/:staffId/advance` — reviewing verification,
sitting through S2.5/S3, then agreements — or move fast: sign A1, create the placement
immediately, get A2/A3 signed against it, and only then call the single `advance → S5_DEPLOY`,
which re-checks every real prerequisite (PV, video cert, signed agreement, medical, DR extras)
regardless of how quickly RM moved. The gate is what actually protects against skipping a step —
not how many separate advance calls RM makes to get there.

## Production deploy status — read before handing this off

**Not live yet, confirmed by direct test.** Two fixes are committed and pushed to `main` (commit
`e29b7f1`) but production was still serving the old build as of the last check:

- `POST /sow` with no `placement_id` still returns `500` in prod (fixed version returns a clean
  `400`) — checked seconds before writing this doc.
- The shift-approval → `StaffDailyAttendance` sync fix is in the same unconfirmed-deployed commit.

Check Render's **Deploys** tab for a stuck/failed build before pointing the mobile app at
production for SOW creation or shift-approval invoice sync — both fixes are verified working
locally, just not yet confirmed live.

---
*Verified against local + production, 2026-08-18.*

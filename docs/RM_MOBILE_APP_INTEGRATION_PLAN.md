# RM Mobile App — Full Integration Plan

Paste this whole document into your Claude session working inside `homegennyapp/` and ask it to
implement Phase 1 first, screen by screen. It has everything needed: current dummy-data state,
exact backend endpoints (all live-tested), request/response shapes, and the architecture pattern
already used elsewhere in this app.

## 0. Current state — what you're replacing

The entire `lib/features/rm/` tree runs on **local Hive data only** — zero backend calls anywhere.
Confirmed by reading every file in `lib/features/rm/presentation/screens/`:

- One repository, `RmRepository` (`lib/features/rm/data/repositories/rm_repository.dart`), talks
  directly to `HiveService` boxes. There is no `RmRemoteDataSource`, `RmLocalDataSource`,
  `RmDummyDataSource`, `RmRepositoryImpl`, or `RmDtoCodec` anywhere — unlike `client`/`staff`
  features, which already follow the remote/local/dummy/executor pattern.
- `MutationQueueService.queueMutation()` marks every write `status: 'SYNCED'` immediately — a fake
  sync simulator, it never calls any API.
- Most screens (tracks 2–5, stage4 A1/A2/A3/OTP/amendment/complete, stage5 trial-checkin,
  compliance-alerts, tasks, alerts) are **static mockups**: hardcoded strings, `onPressed: () {}`
  no-ops, no Riverpod reads at all.
- Only `rm_dashboard_screen`, `rm_pipeline_screen`, `rm_staff_detail_screen`,
  `rm_staff_intake_screen`, and `rm_track1_aadhaar_screen` read/write anything real (and it's all
  Hive, not network).

## 1. Architecture — mirror the existing `client`/`staff` pattern exactly

Do not invent a new pattern. Copy the file layout and conventions from
`lib/features/client/data/` (see `client_datasource.dart`, `client_dtos.dart`,
`client_repository_impl.dart`) and `lib/features/staff/data/` — same idea, RM-scoped:

```
lib/features/rm/
  data/
    datasources/
      rm_datasource.dart      # RmRemoteDataSource, RmLocalDataSource, RmDummyDataSource
      rm_dummy_api.dart       # in-memory fallback for RmDummyDataSource
    models/
      rm_dtos.dart            # RmDtoCodec — static encode*/decode* methods
    repositories/
      rm_repository_impl.dart # implements the domain interface below
  domain/
    models/rm_models.dart     # plain domain models (RmDashboardData, RmPipelineColumn, etc.)
    repositories/rm_repository.dart  # abstract interface
```

- `RmRemoteDataSource extends BaseRemoteDataSource` (from `core/network/api_service.dart`) —
  constructor `RmRemoteDataSource(super.dio)`. Use `getJson`/`postJson`/`putJson`/`patchJson`/
  `uploadMultipart`, matching how `ClientRemoteDataSource`/`StaffRemoteDataSource` are written.
- `RmLocalDataSource extends BaseLocalDataSource` — Hive-backed JSON cache via `StorageKeys`.
  Follow `StaffLocalDataSource`'s trick of falling back to reading `hiveService.staffBox` directly
  for a real (non-demo) user id — reuse that same fallback for RM reading staff records it manages.
- `RmDummyDataSource` wraps `RmDummyApi` + `JsonAssetLoader` — same shape as `ClientDummyDataSource`.
- `RmRepositoryImpl implements RmRepository`, constructor takes
  `{required RepositoryExecutor executor, required RmRemoteDataSource remote, required RmLocalDataSource local, required RmDummyDataSource dummy}`.
  Every read goes through `_executor.fetch(remote:, cache:, local:, dummy:)`; every write through
  `_executor.mutate`/`mutateVoid(remote:, dummy:)`.
- Keep `MutationQueueService` for offline queueing, but wire its flush loop to actually call the
  new `RmRemoteDataSource` methods — today `markAsSynced()` exists but nothing ever calls it.

## 2. Environment / auth (same as every other feature)

- Base URL: `https://homegennyserver-po5u.onrender.com/api/v1` (see
  `docs/MOBILE_API_REFERENCE.md` for the full picture — Auth/Staff/Client APIs, demo accounts,
  gotchas). RM demo login: phone `9800000002`, password `HomeGenny@2024`.
- Every response is `{ success, data, timestamp }` — `BaseRemoteDataSource` already unwraps this.
- `must_change_password` / mock-OTP `123456` flow is identical to Client/Staff — already built in
  the app, nothing new needed here.

## 3. New `ApiConstants` to add

None of these exist yet in `lib/core/constants/api_constants.dart` (the `rm*` constants that do
exist — `rmDashboard`, `rmStaff`, `rmStaffDetail`, `rmFollowUps`, `rmClients`, `rmVerification`,
`rmVideos`, `rmDeployments`, `rmReports`, `rmClientRequests`, `rmNotifications` — were **never
referenced by any RM screen**; some match real backend routes, some don't. Use this list instead,
it matches the real backend exactly):

```dart
// RM core
static const String rmDashboard = '/rm/dashboard';
static const String rmKanban = '/rm/kanban';
static const String rmIntake = '/rm/intake';
static const String rmTrials = '/rm/trials';
static const String rmDeferred = '/rm/deferred';
static const String rmTerminal = '/rm/terminal';
static const String rmUpgrades = '/rm/upgrades';
static const String rmLocations = '/rm/locations';
static String rmPipelineAdvance(String staffId) => '/rm/pipeline/$staffId/advance';
static String rmDeferredResume(String staffId) => '/rm/deferred/$staffId/resume';

// RM incidents
static const String rmIncidents = '/rm/incidents';

// RM shifts / attendance
static const String rmShifts = '/rm/shifts';
static String rmShiftReview(String id) => '/rm/shifts/$id/review';
static const String rmAttendance = '/rm/attendance';
static String rmAttendanceInvoicePreview(String staffId) => '/rm/attendance/$staffId/invoice-preview';
static String rmAttendanceGenerateInvoice(String staffId) => '/rm/attendance/$staffId/generate-invoice';

// Staff record CRUD (RM-facing, distinct from the STAFF role's own /staff/* self-service paths)
static const String staffOnboardingList = '/staff';           // GET list, POST create
static String staffOnboardingDetail(String id) => '/staff/$id';      // GET one, PATCH
static String staffOnboardingTimeline(String id) => '/staff/$id/timeline'; // GET
static const String staffCheckRestricted = '/staff/check-restricted'; // POST

// Verification (RM-triggered actions — mock mode active server-side, see doc)
static const String verifyDl = '/verification/dl';
static String verifyEchallan(String dlNumber) => '/verification/echallan/$dlNumber';
static const String verifyAadhaar = '/verification/aadhaar';
static String verifyPvSubmit(String staffId) => '/verification/pv/submit/$staffId';
static String verifyMedicalSubmit(String staffId) => '/verification/medical/submit/$staffId';

// Video certification
static String videoCertPrompts(String series) => '/video-cert/prompts/$series';
static const String videoCertUploadUrl = '/video-cert/upload-url';
static const String videoCertViewUrl = '/video-cert/view-url';
static const String videoCertVerifyHash = '/video-cert/verify-hash';
static const String videoCertFinalize = '/video-cert/finalize';
static const String videoCertRegister = '/video-cert/register';
static String videoCertList(String staffId) => '/video-cert/list/$staffId';

// Agreements
static const String agreements = '/agreements';
static const String agreementsEsignSendOtp = '/agreements/esign/send-otp';
static const String agreementsEsignVerifyOtp = '/agreements/esign/verify-otp';
static String agreementGeneratePdf(String id) => '/agreements/$id/generate-pdf';
static String agreementSign(String id) => '/agreements/$id/sign';
static String agreementsForClient(String clientId) => '/agreements/client/$clientId';

// SOW (Scope of Work)
static const String sow = '/sow';
static String sowDetail(String id) => '/sow/$id';
static String sowSend(String id) => '/sow/$id/send';
static String sowAmend(String id) => '/sow/$id/amend';

// Placements (already covered in MOBILE_API_REFERENCE.md — repeated here for completeness)
static const String placements = '/placements';
static String placementConfirm(String id) => '/placements/$id/confirm';
static String placementExit(String id) => '/placements/$id/exit';

// Restricted list (alternate path, RM read-only)
static const String restrictedListCheck = '/restricted-list/check';
```

## 4. Phase 1 — screens with a real, live-tested backend today (build these first)

### 4.1 `rm_dashboard_screen.dart`
- Replace `rmDashboardStatsProvider` (Hive) with `GET /rm/dashboard`.
- Response: `{ kpis: { total_staff, active_pipeline, pending_verification, pending_video, trial_placements, active_placements, training_queue, deployment_queue, deferred_cases, monthly_placements, open_incidents, pending_shifts }, funnel: [{stage, count}, ...8 stages], seriesDistribution: [{series, count}, ...] }`.
- Use `funnel` to drive the "Pipeline Distribution" bar (currently hardcoded 15/25/35/15/10) —
  compute real percentages from the 6 forward stages.
- "Recent Activity" feed has no backend source yet — either drop it or wire it later to
  `GET /rm/kanban` sorted by `updated_at` as a rough proxy. Not blocking.

### 4.2 `rm_pipeline_screen.dart`
- Replace `rmPipelineProvider` (Hive, grouped locally) with `GET /rm/kanban?search=&series=&limit=`.
- Response: `{ columns: { S1_INTAKE: [...], S2_VERIFY: [...], S2_5_ASSESS: [...], S3_TRAIN: [...], S4_AGREEMENTS: [...], S5_DEPLOY: [...], DEFERRED: [...], TERMINAL: [...] }, total }`.
- Each row: `id, staff_code, branch_id, assigned_rm_id, series, series_db, role_types, language_tier, pipeline_stage, current_scenario_code, terminal_outcome, full_name, date_of_birth, mobile, email, address, verified_docs, pv_status, restricted_list_flag, video_cert_id, created_at, updated_at`.
- **This gives you the real `series` field** (`DR`/`SC`/`UC`/`MAID`) — replace the current
  staffCode-substring heuristic ("-DR-"/"-MA-") with this real field for the role filter chips.
- Card tap → `staff/:id` route, same as today, now backed by real `id`.

### 4.3 `rm_staff_detail_screen.dart`
- Replace `rmStaffDetailProvider` with `GET /staff/:id` (RM-facing staff CRUD controller — distinct
  from the STAFF role's own `/staff/dashboard` etc.).
- "Onboarding Progress" timeline (currently hardcoded dates) → `GET /staff/:id/timeline` — real
  unified activity + scenario history.
- **"Approve Stage" button** → replace the local `copyWith(pipelineStage:...)` + Hive write with
  `POST /rm/pipeline/:staffId/advance`, body `{ to_stage, reason_code?, payload?, terminal_outcome? }`
  (`terminal_outcome` required only when `to_stage: "TERMINAL"`, must be one of `ENROLLED`,
  `CONDITIONAL`, `DEFERRED`, `DENIED`, `ABANDONED`, `LATE_EXIT`). This is FSM-validated
  server-side — invalid transitions 400 with a clear message, surface it directly.
- Valid `to_stage` values: `S1_INTAKE`, `S2_VERIFY`, `S2_5_ASSESS`, `S3_TRAIN`, `S4_AGREEMENTS`,
  `S5_DEPLOY`, `DEFERRED`, `TERMINAL` — note this is a **different, more granular set** than the
  app's current local 8-stage array (`REGISTRATION/VERIFICATION/TRAINING/VIDEO_CERTIFICATION/
  AGREEMENT/DEPLOYMENT/TRIAL/ACTIVE_PLACEMENT`) — you'll need a mapping table between the two, or
  (recommended) drop the local stage names entirely and use the backend's names throughout the RM
  feature, updating the screen navigation switch to match.
- Document tabs (currently 3 hardcoded cards) — no dedicated RM document-list endpoint exists yet;
  the `verified_docs` JSON field on the staff record (from `GET /staff/:id`) has whatever's been
  captured so far — use that until a dedicated endpoint exists (Phase 2 gap, see §5).

### 4.4 `rm_staff_intake_screen.dart`
- Restricted-list check ("Run Check" button, currently local-only validation) →
  `POST /restricted-list/check` (or the equivalent `POST /staff/check-restricted`, either works —
  RM has read access to both), body `{ aadhaar_number, phone }`, response `{ found, reason? }`.
  Route to the Restricted/Clear result pages based on `found`.
- "Complete Intake" → replace client-generated `HG-<CODE>-2024-<rand>` id + local `StaffEntity`
  write with `POST /rm/intake`, body:
  ```json
  {
    "aadhaar_number": "999988887777",
    "mobile": "9911100001",
    "full_name": "Rohan Test Kumar",
    "date_of_birth": "1998-04-12",
    "address": "Sector 12, Noida",
    "email": "rohan@example.com",
    "series": "MAID",
    "language_tier": "T1",
    "role_types": [],
    "branch_id": "...(optional, defaults to RM's own branch)",
    "deposit_amount": 500,
    "deposit_collected": true,
    "advance_to_verify": true,
    "referral_source": "..."
  }
  ```
  **Deposit amount is NOT auto-derived server-side** — send the right amount for the series
  yourself: DR ₹2000 · SC ₹1500 · UC ₹1000 · MAID ₹500 (the screen currently hardcodes ₹2,000 for
  every role — fix this to branch on the selected series).
  This single call creates the `StaffApplicant` **and** a login-capable STAFF account
  (`HomeGenny@2024`, forced change) — no separate account-creation step needed.
  If the restricted-list check hits internally, the record is created straight at `TERMINAL` with
  no login provisioned — the response will reflect this, branch your success screen on it.

### 4.5 `rm_track1_aadhaar_screen.dart` (and the pattern for tracks 2–5, see §5 for what's still missing)
- Replace the fabricated `'doc-aadhaar-$staffId'` + `approveDocument`/`rejectDocument` Hive calls
  with `POST /verification/aadhaar`, body `{ aadhaar_number, otp, staff_id }` — mock mode is
  active server-side (no live UIDAI key configured), so it **always returns a deterministic
  verified result** and persists it to the staff's `VerificationTrack` row. Any OTP value works in
  mock mode. Reject reason should come from a real text field, not the hardcoded
  `'Mismatched details'` string currently in the code.

### 4.6 Verification actions for tracks 2–5 (screens are currently 100% static — wire the actions even before building real status displays)
- Track 2 (DL): `POST /verification/dl`, body `{ dl_number, dob, staff_id }` — mock mode, always
  VALID, persists to `VerificationTrack`.
- Track 3 (eChallan): `POST /verification/echallan/:dlNumber?staff_id=...` — mock mode, always
  `{ count: 0, challans: [] }`, persists CLEAR.
- Track 4 (Police Verification): `POST /verification/pv/submit/:staffId`, body `{ notes? }` — this
  one is **real**, not mocked — always creates a genuine PENDING `VerificationTrack` record (no
  auto-clear). The "Awaiting Police Clearance" waiting-state UI already on this screen is
  appropriate — just wire the submit action and drop the hardcoded "Day 8 of ~21" copy.
- Track 5 (Medical): `POST /verification/medical/submit/:staffId`, body
  `{ passed: boolean, notes?, verifiedBy? }` — real, not mocked, CLEAR/FAILED based on `passed`.

### 4.7 Video certification (`rm_stage3_video_upload_screen.dart`, `rm_stage3_video_review_screen.dart`)
- Upload flow is a 3-call sequence (already used correctly by the STAFF app's own upload flow —
  copy that pattern):
  1. `POST /video-cert/upload-url`, body `{ staffId, series, filename, sha256Hash? }` → returns a
     GCS signed upload URL + object key.
  2. PUT the video file bytes directly to that signed URL (not through your backend).
  3. `POST /video-cert/finalize`, body `{ staffId, promptKey, gcsKey, expectedHash, attemptNumber? }`
     — verifies the hash server-side and persists the record. (`POST /video-cert/register` is an
     alternate/legacy path — use `finalize`.)
- Stop writing the local file path into `StaffEntity.videoCertification` — that field should go
  away once this is wired; the real record lives server-side, fetch it via
  `GET /video-cert/list/:staffId`.
- **Playback** (for the review screen): `POST /video-cert/view-url`, body `{ key }` → 15-minute
  signed playback URL, RM/BM/Admin only.
- ⚠️ **Known backend gap, flagged not fixed**: the "APPROVE VIDEO"/"REJECT" buttons on the review
  screen have no RM-accessible backend action today. The real approve/reject endpoint is
  `PUT /trainer/video-certifications/:id/review` and it's **TRAINER/ADMIN-only**, not RM, despite
  the product spec saying RM should review. Either get backend to open this endpoint to RM, or
  point the mobile dev's Claude at this exact gap so the button can show a clear "pending trainer
  review" state instead of silently doing nothing.

### 4.8 Agreements — Stage 4 (`rm_stage4_*` screens)
- List/create: `GET /agreements`, `POST /agreements` (RM/BM/Admin).
- e-Sign OTP: `POST /agreements/esign/send-otp` body `{ staff_id, agreement_type, staff_name }`,
  then `POST /agreements/esign/verify-otp` body `{ staff_id, agreement_type, otp }` — this is the
  real backing for the currently-static `rm_stage4_otp_screen.dart` (which today just shows a
  snackbar and never calls anything).
- Sign: `POST /agreements/:id/sign`, body `{ otp? }`.
- Generate PDF: `POST /agreements/:id/generate-pdf`.
- SOW (the A2 client-facing document): `POST /sow` (create), `GET /sow`, `PATCH /sow/:id`,
  `POST /sow/:id/send`, `POST /sow/:id/amend` — this backs `rm_stage4_a2_screen.dart`,
  `rm_stage4_a2_client_screen.dart`, and `rm_stage4_sow_amendment_screen.dart` (all currently
  snackbar-only no-ops).
- A3 (Client Indemnity) has no dedicated endpoint of its own in this pass — treat it as another
  `agreements` record with its own `agreement_type`, signed the same way via `/agreements/:id/sign`.

### 4.9 `rm_tasks_screen.dart`, `rm_alerts_screen.dart`
- No RM-specific "tasks"/"alerts" endpoint exists yet distinct from the pipeline data itself.
  Reasonable interim wiring: derive both screens from `GET /rm/kanban` (staff needing action,
  e.g. `S2_VERIFY` with missing tracks) and `GET /rm/incidents?status=OPEN` — not a perfect match
  to the current mockup copy, but real data. Treat a dedicated `/rm/tasks` and `/rm/notifications`
  (in-app) as a Phase 2 backend ask if the product wants the exact current UI preserved.
  `GET /notifications/in-app` (used elsewhere in the web app as `getHrNotifications`) may already
  be reusable here — check the `notifications` module's role gating before wiring.

### 4.10 Shifts / Attendance / Incidents (not in any current RM screen, but real and RM-relevant)
- `GET /rm/shifts?status=`, `PATCH /rm/shifts/:id/review` body `{ action: "APPROVED"|"REJECTED"|"FLAGGED", notes? }`.
- `GET /rm/attendance?branchId=&month=&year=&branchCode=`, `PUT /rm/attendance` body
  `{ staff_id, date, status?, overtime_hours?, branch_id? }`.
- `GET /rm/attendance/:staffId/invoice-preview?month=&year=`,
  `POST /rm/attendance/:staffId/generate-invoice?month=&year=`.
- `GET /rm/incidents?status=`, `POST /rm/incidents` body
  `{ staff_id?, type, title, description?, client_id?, placement_id?, evidence_urls? }`.
- These have no current screen in the app at all — worth a "Shifts" and "Incidents" tab/screen if
  the product wants RM to do this from mobile (currently only the web RM portal has these).

### 4.11 Placements
- Already fully covered in `docs/MOBILE_API_REFERENCE.md` §4 — `POST /placements` (creates
  `TRIAL`), `POST /placements/:id/confirm` (→ `CONFIRMED`, unlocks staff check-in/attendance/
  invoicing), `POST /placements/:id/exit`. No current RM screen covers this at all — `rm_stage5_
  trial_checkin_screen.dart` is the natural home for "Confirm Placement" but is currently 100%
  static with a hardcoded navigation target (`clientInvoice('demo')` — literal string `'demo'`,
  not even the real staffId). Rebuild this screen against the placements endpoints; use the
  staff-picker/client-picker pattern documented there (`GET /rm/kanban` filtered to `S5_DEPLOY`,
  `GET /finance/customers`).

## 5. Phase 2 — backend gaps found during this research (not built yet, flag to backend before wiring these screens)

These screens currently show entirely fabricated data with no real endpoint to call at all. Don't
guess at a shape — get the backend to build and confirm the exact response first:

- **Aggregate verification-track status** (`rm_verification_dashboard_screen.dart`'s 5 track
  cards). The data exists (`VerificationTrack` rows are readable internally via
  `staffApplicant.findUnique({ include: { verificationTracks: true } })` in
  `staff-mobile.controller.ts`), but there's **no GET endpoint that exposes it to RM**. Needs
  something like `GET /rm/staff/:id/verification` returning all 5 tracks' current status.
- **Training module list/progress** (`rm_stage3_training_screen.dart`) — `TrainingEntity` exists
  as a Flutter Hive model but nothing on the backend serves training module data to RM at all.
- **Trial check-in data** (day count, ratings) for `rm_stage5_trial_checkin_screen.dart` beyond
  what `GET /placements` already gives you (trial_start_date/trial_end_date) — decision-recording
  (`POST /rm/staff/:id/trial/checkin` or similar) doesn't exist; use the placements
  confirm/exit endpoints instead (§4.11), they cover the actual state transition even without a
  dedicated "trial checkin" resource.
- **Compliance alerts** (`rm_compliance_alerts_screen.dart` — DL expiry, new eChallans, invoice
  overdue) — no endpoint exists. Could plausibly be derived client-side from `GET /rm/kanban` +
  `GET /finance/invoices` once those are wired, but there's no single source of truth for this
  today.
- **RM tasks** as a distinct resource from incidents/kanban — no endpoint (see §4.9).

## 6. Suggested implementation order

1. §4.1–4.3 (Dashboard, Pipeline, Staff Detail + Advance Stage) — highest value, all endpoints
   ready, unlocks the core "see my pipeline and move people through it" loop.
2. §4.4 (Intake) — the entry point to the whole pipeline.
3. §4.5–4.7 (Verification tracks + video-cert) — the S2/S3 middle of the funnel.
4. §4.11 (Placements) — S5, ties into the client-side work already shipped.
5. §4.8 (Agreements/SOW) — S4, more screens but same request/response pattern throughout.
6. §4.9–4.10 (Tasks/Alerts/Shifts/Attendance/Incidents) — lower priority, either derive from
   existing data or wait on Phase 2 backend work.
7. Phase 2 items (§5) — flag to backend, don't build against a guessed shape.

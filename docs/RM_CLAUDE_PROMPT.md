# HomeGenny — RM Mobile App API Integration & Complete Pipeline Workflow

You are working on the **HomeGenny Flutter mobile application**.

Your task is to inspect the existing Flutter project, inspect the existing UI/screens/repositories/API services, inspect the live Swagger API documentation, and then implement the **complete, production-ready RM user API functionality**.

Do NOT redesign the existing UI unless a small UI modification is required to make a workflow functional.

The UI/design already exists. Your responsibility is to connect the UI correctly with the backend APIs and make the complete RM workflow actually work end-to-end.

---

# 1. Backend API Sources

Use the live backend as the source of truth:

**Live API Base URL**

`https://homegennyserver-po5u.onrender.com/api/v1`

**Swagger**

`https://homegennyserver-po5u.onrender.com/api/docs#/`

**Swagger JSON**

`https://homegennyserver-po5u.onrender.com/api/docs-json`

IMPORTANT:

All API requests must use:

`/api/v1/...`

Do NOT accidentally call:

`/auth/...`

instead of:

`/api/v1/auth/...`

The API uses:

```json
{
  "success": true,
  "data": {},
  "timestamp": "..."
}
```

Authentication uses:

```http
Authorization: Bearer <access_token>
```

Read the existing API layer before creating anything new.

Do not duplicate repositories, API clients, models, or services that already exist.

---

# 2. Primary Requirement

Implement the **complete RM mobile application workflow**.

The RM application must be fully functional from:

```text
Login
 ↓
RM Dashboard
 ↓
Pipeline
 ↓
Staff Intake
 ↓
S1 Intake
 ↓
S2 Verification
 ↓
S2.5 Assessment
 ↓
S3 Training
 ↓
S4 Agreements
 ↓
S5 Deploy
 ↓
Create Placement
 ↓
TRIAL Placement
 ↓
Confirm Placement
 ↓
CONFIRMED Placement
 ↓
Attendance / Shift Monitoring
 ↓
Shift Review
 ↓
Invoice / Payroll Preview
 ↓
Incident Management
 ↓
Placement Exit
```

The most important requirement is:

> Every pipeline stage must actually work through API calls, and the RM must only move a staff member to the next stage after the current stage is completed.

Do NOT make the pipeline a visual-only UI.

The pipeline must represent the real backend state.

---

# 3. First: Inspect the Existing Project

Before modifying code, inspect the complete Flutter project.

Analyze:

* lib/
* routes
* authentication
* API client
* Dio/http configuration
* repositories
* services
* models
* controllers/providers/blocs/GetX
* RM screens
* RM widgets
* pipeline widgets
* placement screens
* staff screens
* client picker
* attendance screens
* shift screens
* incident screens
* invoice screens
* navigation
* local storage
* token management

Search the project for:

```text
RM
Relationship Manager
pipeline
kanban
staff
placement
attendance
shift
incident
invoice
dashboard
intake
verification
assessment
training
agreements
deploy
```

Also search for existing API implementations such as:

```text
/rm
/placements
/verification
/assessments
/agreements
/sow
/trainer
/finance/customers
```

Reuse existing architecture whenever possible.

---

# 4. Inspect Swagger

Open and inspect the Swagger API.

Filter by:

**Mobile App RM APIs**

But do NOT blindly implement every endpoint under that Swagger tag.

The API reference explicitly states that the tag is broad and contains routes from Verification, Video Certification, Staff, and Placement controllers as well.

Use only APIs that belong to the RM workflow.

The primary RM APIs are:

```text
GET    /rm/dashboard
GET    /rm/kanban
POST   /rm/intake
POST   /rm/pipeline/:staffId/advance

GET    /rm/trials
GET    /rm/deferred
POST   /rm/deferred/:staffId/resume
GET    /rm/terminal

GET    /rm/incidents
POST   /rm/incidents

GET    /rm/shifts
PATCH  /rm/shifts/:id/review

GET    /rm/upgrades
GET    /rm/locations

GET    /rm/attendance
PUT    /rm/attendance

GET    /rm/attendance/:staffId/invoice-preview
POST   /rm/attendance/:staffId/generate-invoice
```

Also inspect the placement APIs:

```text
POST /placements
GET  /placements
POST /placements/:id/confirm
POST /placements/:id/exit
```

Verification (S2):

```text
POST /verification/aadhaar
POST /verification/dl
POST /verification/echallan/:dlNumber
POST /verification/pv/submit/:staffId
POST /verification/medical/submit/:staffId
```

Assessment (S2.5 — RM has access):

```text
GET  /assessments
POST /assessments/create
GET  /assessments/:id
PUT  /assessments/update/:id
POST /assessments/submit
```

Agreements (S4 — this is NOT an assessment stage, it's contracts/e-sign):

```text
GET  /agreements
POST /agreements
POST /agreements/esign/send-otp
POST /agreements/esign/verify-otp
POST /agreements/:id/sign
POST /agreements/:id/generate-pdf
GET  /sow
POST /sow
PATCH /sow/:id
POST /sow/:id/send
POST /sow/:id/amend
```

Client selection:

```text
GET /finance/customers
```

Confirm the exact request/response schemas from Swagger before implementing.

---

# 5. Authentication

Make sure the RM authentication flow is complete.

Login:

```text
POST /api/v1/auth/login
```

Request:

```json
{
  "phone": "...",
  "password": "..."
}
```

Store:

```text
access_token
refresh_token
user information
role
must_change_password
```

If:

```text
must_change_password == true
```

navigate to the forced password-change flow.

Every protected RM request must send:

```http
Authorization: Bearer <access_token>
```

Implement token refresh if the existing application architecture supports it.

Do not hardcode tokens.

---

# 6. RM Dashboard

Connect the RM Dashboard to:

```text
GET /rm/dashboard
```

Display real API data.

Dashboard should show relevant RM KPIs such as:

* total staff
* pipeline counts
* current stage counts
* trial staff
* deployed staff
* deferred staff
* terminal/rejected staff
* pending actions
* shift review information

Do not use fake/mock values if API data exists.

Add:

* loading state
* empty state
* API error state
* retry
* pull-to-refresh

After successful pipeline changes, refresh dashboard data.

---

# 7. RM Pipeline / Kanban

This is the MOST IMPORTANT module.

Use:

```text
GET /rm/kanban
```

The pipeline screen must display staff grouped by their actual backend pipeline stage.

Do NOT hardcode the current stage based on UI state.

The API response is the source of truth.

**The backend's real pipeline has exactly these 8 stage values — confirmed from the
`PIPELINE_STAGES` constant in `rm.controller.ts`. Use these exact strings, nothing else,
nowhere in the app:**

```text
S1_INTAKE
 ↓
S2_VERIFY
 ↓
S2_5_ASSESS
 ↓
S3_TRAIN
 ↓
S4_AGREEMENTS
 ↓
S5_DEPLOY

(plus two exception states outside the forward flow: DEFERRED, TERMINAL)
```

Two corrections to a common misreading of this pipeline — get these right, they change which
API you reach for at each stage:

* **`S2_5_ASSESS` is the real "Assessment" stage** — it sits between Verification and Training,
  not after Training. It's backed by the `/assessments` endpoints (RM has access).
* **`S4_AGREEMENTS` is NOT an assessment stage** — it's the agreements/contracts stage (A1
  Employment, A2 Scope-of-Work, A3 Client Indemnity), backed by `/agreements` and `/sow`.

If the backend exposes additional stage values beyond these 8, inspect Swagger/API response and
support those values correctly rather than inventing new ones.

---

# 8. Pipeline Stage Rules

Implement proper stage gating.

The real workflow, using the exact backend stage names:

```text
S1_INTAKE
   ↓
S2_VERIFY
   ↓
S2_5_ASSESS
   ↓
S3_TRAIN
   ↓
S4_AGREEMENTS
   ↓
S5_DEPLOY
```

A staff member must NOT be allowed to skip stages.

For example:

```text
S1_INTAKE → S2_5_ASSESS
```

must not be possible.

Correct:

```text
S1_INTAKE → S2_VERIFY
S2_VERIFY → S2_5_ASSESS
S2_5_ASSESS → S3_TRAIN
S3_TRAIN → S4_AGREEMENTS
S4_AGREEMENTS → S5_DEPLOY
```

The UI must make this obvious.

`POST /rm/pipeline/:staffId/advance`'s `to_stage` field only accepts these exact 8 strings —
sending anything else (e.g. a made-up `"S4_ASSESSMENT"`) will 400.

---

# 9. Advance Pipeline API

Use:

```text
POST /rm/pipeline/:staffId/advance
```

When the RM clicks:

```text
Complete Stage
```

or equivalent existing UI action:

1. Validate that the current stage is eligible for completion.
2. Show confirmation if required.
3. Call the advance API.
4. Handle API success.
5. Update the stage.
6. Refresh pipeline data.
7. Refresh dashboard counters.
8. Navigate/update UI to the next stage.
9. Display success feedback.

Do NOT manually change the stage locally and assume the API succeeded.

The backend response must determine the final state.

---

# 10. S1 — Intake

Use:

```text
POST /rm/intake
```

Implement the existing RM intake form.

On submit:

```text
Validate form
 ↓
POST /rm/intake
 ↓
Staff created
 ↓
Refresh Kanban
 ↓
Staff appears in S1_INTAKE
```

Show validation errors returned by the API.

Do not lose partially entered form data unnecessarily.

---

# 11. S1 → S2

On the staff detail/pipeline stage screen:

```text
Current Stage = S1_INTAKE
```

Show:

```text
Complete Intake
```

When complete:

```text
POST /rm/pipeline/:staffId/advance   body: { "to_stage": "S2_VERIFY" }
```

After success:

```text
S1_INTAKE
       ↓
S2_VERIFY
```

Refresh the staff detail and pipeline.

---

# 12. S2 — Verification

The verification stage should display the staff verification status.

Use the appropriate existing verification APIs from Swagger:

```text
POST /verification/aadhaar
POST /verification/dl
POST /verification/echallan/:dlNumber
POST /verification/pv/submit/:staffId
POST /verification/medical/submit/:staffId
```

Inspect the exact Swagger request schema for each before implementing.

Note: `aadhaar`/`dl`/`echallan` currently run in a deterministic **mock mode** server-side (no
live Sarathi/UIDAI key configured) — they always succeed and persist a mock-verified result. `pv`
and `medical` are real (not mocked): `pv` always creates a genuine PENDING record with no
auto-clear, `medical` is CLEAR/FAILED based on the `passed` boolean you send.

The RM should be able to trigger/check the verification flow from the existing UI.

The stage should not visually appear completed simply because the user opened the page.

Use actual API response/status.

Only allow:

```text
S2_VERIFY → S2_5_ASSESS
```

when the verification stage requirements are satisfied according to the backend response/model.

If the backend itself allows advance without validation, enforce the workflow gate in the Flutter application.

---

# 13. S2.5 — Assessment

This is a real, distinct stage — it comes right after Verification, before Training. It is backed
by its own module:

```text
GET  /assessments
POST /assessments/create
GET  /assessments/:id
PUT  /assessments/update/:id
POST /assessments/submit
```

RM has access to all of these. Inspect the exact Swagger request/response schema before
implementing — the request bodies for `create`/`update`/`submit` are loosely typed on the backend
(`data: any`), so confirm the actual fields in use by checking any existing assessment records via
`GET /assessments` first.

Implement:

```text
Assessment status
Assessment result
Pass/fail state
Completion state
```

The RM must not be able to blindly skip assessment.

Expected flow:

```text
Verification Completed
       ↓
Assessment (S2.5)
       ↓
PASS
       ↓
S3_TRAIN
```

If assessment fails, remain at `S2_5_ASSESS` — do not automatically advance. Use the actual
backend status, not a locally-inferred one.

---

# 14. S3 — Training

Inspect the existing Training UI and available APIs.

Determine from the existing code and Swagger:

* training status
* trainer assignment
* video certification
* training completion
* required documents
* available actions

Do NOT assume an API exists if Swagger does not expose it. As of this writing, **no dedicated
RM-facing training-module status/completion endpoint exists on the backend** — do not fabricate
one. If no suitable API exists:

* do not create fake completion
* clearly isolate the missing backend dependency
* still implement the UI state handling around whatever IS available (e.g. video-cert endpoints
  below, which are real)

Video certification (part of this stage, real endpoints):

```text
GET  /video-cert/prompts/:series
POST /video-cert/upload-url
POST /video-cert/finalize
POST /video-cert/view-url
GET  /video-cert/list/:staffId
```

⚠️ Known gap: the actual approve/reject action for a video certification is
`PUT /trainer/video-certifications/:id/review`, and it is **TRAINER/ADMIN-only, not RM** — despite
living under the "Mobile App RM APIs" Swagger tag. Do not build an RM-facing approve/reject button
against this endpoint; it will 403. Show a "pending trainer review" state instead.

Only allow:

```text
S3_TRAIN → S4_AGREEMENTS
```

when training completion requirements are satisfied (or, given the gap above, RM manual sign-off
via `POST /rm/pipeline/:staffId/advance` if that's the product's accepted workaround — confirm
with the product owner, don't assume).

---

# 15. S4 — Agreements

This stage is contracts/e-sign, **not** assessment (assessment already happened at S2.5). Backing
endpoints:

```text
GET   /agreements
POST  /agreements
POST  /agreements/esign/send-otp     body: { staff_id, agreement_type, staff_name }
POST  /agreements/esign/verify-otp   body: { staff_id, agreement_type, otp }
POST  /agreements/:id/sign           body: { otp? }
POST  /agreements/:id/generate-pdf

GET   /sow
POST  /sow
PATCH /sow/:id
POST  /sow/:id/send
POST  /sow/:id/amend
```

Implement the three agreement instruments this stage covers — A1 (Employment/EOR), A2 (Scope of
Work, via the `/sow` endpoints), A3 (Client Indemnity, another `/agreements` record with its own
`agreement_type`) — each following the same create → send-OTP → verify-OTP → sign → generate-PDF
sequence.

The RM must not be able to blindly skip this stage.

Expected flow:

```text
Training Completed (S3_TRAIN)
       ↓
A1 Signed, A2 Signed, A3 Signed (S4_AGREEMENTS)
       ↓
S5_DEPLOY
```

Only advance to `S5_DEPLOY` once all required agreements for this staff are actually signed —
check via `GET /agreements` / `GET /sow`, don't infer from UI state.

---

# 16. S5 — Deploy

This is the final pipeline stage before placement.

When:

```text
pipeline_stage == "S5_DEPLOY"
```

the RM should see:

```text
Ready for Placement
```

The Create Placement action must be enabled.

For every staff member below S5_DEPLOY:

```text
Create Placement = disabled/hidden
```

The backend currently does not enforce this stage restriction on `POST /placements` itself, so
the Flutter app MUST enforce it client-side.

This is a critical business rule.

---

# 17. Placement Creation

Only allow placement creation for:

```text
pipeline_stage == "S5_DEPLOY"
```

Staff picker should be populated from:

```text
GET /rm/kanban
```

filtered to the `S5_DEPLOY` column, or:

```text
GET /rm/dashboard
```

Capture:

```text
StaffApplicant.id     (the "id" field on the kanban row)
```

IMPORTANT:

Do NOT use:

```text
User.id     (the login/auth id)
```

for:

```text
staff_id
```

The API expects `StaffApplicant.id`. There is no foreign-key constraint enforcing this on the
backend — passing the wrong id is silently accepted and only surfaces later as a placement that
mysteriously never shows up for the right staff. This exact mistake has happened during live
testing — be careful here.

For client selection use:

```text
GET /finance/customers
```

Capture:

```text
FinanceCustomer.id
```

Do NOT use the client's login `User.id`. Same failure mode as above.

This distinction is critical for placement/check-in/dashboard functionality.

---

# 18. Placement Form

Use the existing placement UI.

Fields should include the API-supported fields such as:

```text
staff_id
client_id
staff_salary
management_fee
trial_start_date   (optional, defaults to today)
trial_end_date     (optional, defaults to +14 days)
```

Use the exact Swagger request schema.

Submit:

```text
POST /placements
```

Expected result:

```text
status = "TRIAL"
```

IMPORTANT:

Creating a placement does NOT mean the placement is confirmed.

The UI must clearly show:

```text
TRIAL — Pending Confirmation
```

---

# 19. Placement Confirmation — VERY IMPORTANT

After placement creation:

```text
POST /placements
```

returns:

```text
"status": "TRIAL"
```

The RM must then see:

```text
Confirm Placement
```

Call:

```text
POST /placements/:id/confirm
```

Only after this succeeds:

```text
TRIAL
 ↓
CONFIRMED
```

The UI must clearly communicate:

```text
Placement Confirmed
```

Only `CONFIRMED` placement unlocks:

```text
Staff Check-in
Attendance
RM Attendance
Payroll
Invoice generation
```

Do NOT treat TRIAL as CONFIRMED.

If the API returns 400 because the placement is already confirmed or not in TRIAL:

* show the backend error message (it's a clear, human-readable string)
* refresh placement data
* do not crash the application

---

# 20. Placement State Machine

Implement this exact state model — this is the single most important business rule in this whole
task, and the one most likely to make the pipeline *look* complete while still being functionally
broken if skipped:

```text
S5_DEPLOY
   │
   │ POST /placements
   ▼
TRIAL
   │
   │ POST /placements/:id/confirm
   ▼
CONFIRMED
   │
   │ POST /placements/:id/exit
   ▼
EXITED
```

The UI must reflect the backend state.

Never infer confirmation merely because placement creation succeeded. `S5_DEPLOY → CONFIRMED`
directly is not a real transition — it always goes through `TRIAL` first, and confirmation is a
separate, explicit RM action.

---

# 21. Trial Module

Connect:

```text
GET /rm/trials
```

Display:

* staff
* client
* trial start
* trial end
* placement status
* actions

From trial details, allow the RM to confirm the placement when appropriate (same
`POST /placements/:id/confirm` call as §19).

After confirmation, refresh `GET /rm/trials` and the placements list so state stays in sync.

---

# 22. Deferred Module

Connect:

```text
GET /rm/deferred
```

Display deferred staff.

For resume:

```text
POST /rm/deferred/:staffId/resume    body: { "to_stage": "..." }
```

`to_stage` must be one of the 8 real stage values from §7.

After successful resume:

```text
Refresh deferred list
Refresh kanban
Refresh dashboard
```

The staff should return to the correct pipeline state based on the backend response.

---

# 23. Terminal Module

Connect:

```text
GET /rm/terminal
```

Display terminated/rejected applicants.

Terminal records should be read-only unless Swagger exposes an explicit action.

Do not provide unsupported actions.

---

# 24. Shift Review

Connect:

```text
GET /rm/shifts
```

Display pending/reviewed shift logs.

For review:

```text
PATCH /rm/shifts/:id/review
```

Request:

```json
{
  "action": "APPROVED",
  "notes": "..."
}
```

Supported actions:

```text
APPROVED
REJECTED
FLAGGED
```

After review:

```text
Refresh shift list
Refresh dashboard
Refresh attendance/invoice-related data
```

Do not locally mark the shift as approved before the API succeeds.

---

# 25. Attendance

Connect:

```text
GET /rm/attendance
PUT /rm/attendance
```

Inspect Swagger for exact request/query schemas.

Implement:

* attendance list
* date filtering
* staff filtering if supported
* mark/update attendance
* loading
* errors
* empty states

Do not allow attendance operations against an unconfirmed placement if the backend requires CONFIRMED.

---

# 26. Invoice Preview

Connect:

```text
GET /rm/attendance/:staffId/invoice-preview
```

Show the payroll/invoice preview before generation.

Display the actual API values.

Do not calculate a different amount in the frontend if the backend already provides the calculation.

The backend should be the source of truth for:

```text
salary
management fee
attendance calculation
totals
```

---

# 27. Invoice Generation

Connect:

```text
POST /rm/attendance/:staffId/generate-invoice
```

Before calling:

* ensure placement is CONFIRMED
* ensure required attendance data exists
* confirm with the RM if the existing UI has a confirmation step

After success:

```text
Refresh invoice/attendance state
Show generated invoice result
```

Handle duplicate generation errors gracefully.

---

# 28. Incidents

Connect:

```text
GET /rm/incidents
POST /rm/incidents
```

Implement:

* incident list
* incident details
* create incident
* status
* staff reference
* notes/details
* validation
* refresh

Use only the `IncidentType` values the backend actually supports today:

```text
CLIENT_COMPLAINT
STAFF_MISCONDUCT
SAFETY_ISSUE
ATTENDANCE_FRAUD
DRIVING_VIOLATION
LATE_EXIT
```

Do not invent additional enum values — a broader set was planned but is currently blocked on a
database permission issue and not yet live.

---

# 29. Locations

Connect:

```text
GET /rm/locations
```

Use the API response to show staff location/GPS information in the existing UI.

If the existing UI has map functionality:

* use API coordinates
* handle missing coordinates
* handle permission/API failures
* do not display fake coordinates

---

# 30. Upgrades

Connect:

```text
GET /rm/upgrades
```

Display series/role upgrade requests.

Use the exact backend statuses.

Do not invent approval APIs if Swagger does not expose them.

---

# 31. RM Staff Detail Screen

Every staff member should have a usable detail page.

The page should show:

```text
Staff information
↓
Current pipeline stage
↓
Stage completion/status
↓
Verification (S2_VERIFY)
↓
Assessment (S2_5_ASSESS)
↓
Training (S3_TRAIN)
↓
Agreements (S4_AGREEMENTS)
↓
Deployment readiness (S5_DEPLOY)
↓
Placement
↓
Trial/Confirmed status
↓
Attendance
↓
Incidents
↓
Location
```

Actions must depend on actual state.

Example:

```text
S1_INTAKE      → Complete Intake
S2_VERIFY      → Complete Verification
S2_5_ASSESS    → Complete Assessment
S3_TRAIN       → Complete Training
S4_AGREEMENTS  → Complete Agreements
S5_DEPLOY      → Create Placement
TRIAL          → Confirm Placement
CONFIRMED      → Attendance / Exit
```

Do not display all actions simultaneously.

---

# 32. Navigation Rules

Navigation must follow backend state.

When an API action succeeds:

```text
API Success
 ↓
Update local state
 ↓
Refresh relevant API
 ↓
Update UI
 ↓
Navigate to next logical page
```

Avoid stale pipeline data.

If the RM returns to the pipeline screen, fetch the latest server state.

---

# 33. Error Handling

Create consistent API error handling.

Handle:

```text
400
401
403
404
409
422
500
network timeout
connection failure
```

For backend validation errors, show the actual meaningful API message wherever appropriate.

For:

```text
401
```

refresh token or redirect to login according to the existing authentication architecture.

Do not expose raw technical stack traces to users.

---

# 34. Loading / Empty / Error States

Every RM page that calls an API must have:

```text
Loading
Success
Empty
Error
Retry
```

No screen should remain stuck on an infinite loader.

For mutation operations:

```text
Disable button while request is running
Prevent duplicate API calls
Show success/error feedback
Refresh server data
```

---

# 35. API Architecture

Follow the project's existing architecture.

If the project uses:

```text
Repository
Service
Controller
Provider
Bloc
GetX
```

continue using the existing pattern.

Do not introduce a completely different architecture.

Create/update models for:

```text
RM Dashboard
Kanban
Staff Applicant
Pipeline Stage
Verification
Assessment
Training
Agreements
Placement
Trial
Incident
Shift
Attendance
Invoice Preview
Location
Upgrade
```

Use null-safe Dart models.

Handle missing/null API fields safely.

---

# 36. Local Storage

Persist only information that should actually persist, such as:

```text
access_token
refresh_token
user session
RM role
```

Do not persist stale pipeline data as the source of truth.

Server API must remain authoritative for:

```text
pipeline stage
placement status
attendance
shift status
invoice status
verification
assessment
training
agreements
```

---

# 37. Critical Business Rules

Implement these rules exactly:

### Rule 1

A staff member cannot skip pipeline stages.

```text
S1_INTAKE → S2_VERIFY → S2_5_ASSESS → S3_TRAIN → S4_AGREEMENTS → S5_DEPLOY
```

### Rule 2

Placement creation is available only at:

```text
S5_DEPLOY
```

### Rule 3

`POST /placements` creates:

```text
TRIAL
```

not CONFIRMED.

### Rule 4

RM must explicitly call:

```text
POST /placements/:id/confirm
```

### Rule 5

Only:

```text
CONFIRMED
```

placement unlocks attendance/check-in/payroll/invoicing.

### Rule 6

Use:

```text
StaffApplicant.id
```

for placement `staff_id`.

### Rule 7

Use:

```text
FinanceCustomer.id
```

for placement `client_id`.

### Rule 8

Never fake completion of a pipeline stage.

### Rule 9

Never use hardcoded mock data when the real API is available.

### Rule 10

Never silently swallow API errors.

### Rule 11

`S2_5_ASSESS` is the real assessment stage (between Verification and Training) — don't confuse it
with `S4_AGREEMENTS`, which is contracts/e-sign, not assessment.

---

# 38. Important Backend Gap Handling

The API reference contains some known backend limitations.

Do not pretend unsupported functionality exists.

For example:

* Video certification approve/reject under the RM Swagger tag is actually Trainer/Admin-only.
* No dedicated training-module status/completion endpoint exists yet.
* Backend placement creation currently does not itself enforce S5_DEPLOY.
* The frontend therefore MUST enforce the S5 placement gate.
* `IncidentType` only supports 6 values today, not a broader set.

If an expected RM action has no backend API:

1. Identify it.
2. Do not create a fake API response.
3. Do not fake successful completion.
4. Document the missing endpoint.
5. Implement everything possible using existing APIs.

---

# 39. Testing Strategy

After implementation, test the complete workflow using real APIs.

Test:

```text
RM Login
 ↓
Dashboard
 ↓
Kanban
 ↓
Create Staff (S1_INTAKE)
 ↓
Advance → S2_VERIFY
 ↓
Verification
 ↓
Advance → S2_5_ASSESS
 ↓
Assessment
 ↓
Advance → S3_TRAIN
 ↓
Training
 ↓
Advance → S4_AGREEMENTS
 ↓
Agreements (A1/A2/A3 signed)
 ↓
Advance → S5_DEPLOY
 ↓
Select Staff
 ↓
Select Client
 ↓
Create Placement → TRIAL
 ↓
Confirm Placement → CONFIRMED
 ↓
Attendance
 ↓
Shift Review
 ↓
Invoice Preview
 ↓
Generate Invoice
```

Also test negative scenarios:

```text
Try to skip S1_INTAKE → S2_5_ASSESS directly
Try placement before S5_DEPLOY
Try duplicate placement confirmation
Try attendance before CONFIRMED
Try invoice before required attendance
API timeout
401 token expiry
Empty pipeline
No client available
No deploy-ready staff
Invalid staff ID
Invalid client ID
```

**Test the S5_DEPLOY → POST /placements → TRIAL → POST /placements/:id/confirm → CONFIRMED
sequence end-to-end first, before anything else.** This is the one most likely to make the
pipeline *look* complete while still being functionally broken if the confirm step is missed.

---

# 40. Do Not Stop at API Wiring

The task is NOT complete merely because:

```text
Dio call works
```

The task is complete only when:

```text
UI
 ↓
Repository
 ↓
API
 ↓
Response
 ↓
State update
 ↓
UI refresh
 ↓
Navigation
```

works correctly.

Every RM page should be connected to real backend state.

---

# 41. Final Audit

Before finishing, perform a complete audit.

Create a table internally with:

```text
RM Screen
API
HTTP Method
Request Model
Response Model
Repository
State Management
Loading State
Error State
Success State
Navigation
```

Verify every RM screen.

Then search the codebase for:

```text
TODO
FIXME
mock
dummy
hardcoded
fake
static
sample
temporary
```

Remove mock behavior where a real API exists.

Do not remove legitimate placeholders where the backend API genuinely does not exist; document those separately.

---

# 42. Final Deliverable

After implementation, report:

### A. Implemented RM modules

List every completed module.

### B. API mapping

For every RM page:

```text
Page → API → Method → Purpose
```

### C. Pipeline flow

Show:

```text
S1_INTAKE → S2_VERIFY → S2_5_ASSESS → S3_TRAIN → S4_AGREEMENTS → S5_DEPLOY → Placement TRIAL → CONFIRMED
```

### D. Remaining backend gaps

List only functionality that cannot be completed because the backend/API does not expose the required operation.

### E. Files changed

List all modified/created files.

### F. Testing result

Report:

```text
PASS
FAIL
BLOCKED
```

for every major RM workflow.

### G. Important

Do not claim something is fully working unless you actually verified the API call and UI state transition.

The priority is:

**REAL API → CORRECT STATE → CORRECT PIPELINE GATING → CORRECT NAVIGATION → WORKING UI**

Do not break existing Client or Staff functionality while implementing RM.

---

### One important point for your Claude session

Tell Claude to **first inspect the existing Flutter code and API architecture before making
changes**. That will prevent it from creating duplicate repositories/controllers.

The RM Swagger tag is broad, while the actual RM endpoints are the `/rm/*` routes; placement/
verification/assessment/agreement APIs should be incorporated only where they belong in the RM
workflow — see `docs/RM_MOBILE_APP_INTEGRATION_PLAN.md` for the full screen-by-screen breakdown
this prompt is derived from.

**The biggest business rule to watch during testing:**

`S5_DEPLOY → POST /placements → TRIAL → POST /placements/:id/confirm → CONFIRMED`

— not `S5_DEPLOY → CONFIRMED` directly, and not `S4_AGREEMENTS` mistaken for an assessment stage
(the real assessment stage is `S2_5_ASSESS`). Both distinctions are the parts most likely to make
the RM pipeline *look* complete while still being functionally wrong — test them end-to-end first.

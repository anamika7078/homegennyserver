# HomeGenny Mobile API — Reference for App Integration

This document is written to be pasted directly into an AI assistant (Claude, etc.) as context for
integrating the HomeGenny mobile APIs into the Flutter app. It covers all four mobile-facing API
groups: **Auth**, **RM**, **Staff**, and **Client**.

> **Building out the RM screens specifically?** See
> [`RM_MOBILE_APP_INTEGRATION_PLAN.md`](./RM_MOBILE_APP_INTEGRATION_PLAN.md) — a screen-by-screen
> plan against the Flutter app's actual current (dummy-data) RM feature, covering every endpoint
> below in context plus the exact `ApiConstants`/architecture to add.

## 1. Environment

- **Live base URL**: `https://homegennyserver-po5u.onrender.com/api/v1`
- **Swagger UI**: `https://homegennyserver-po5u.onrender.com/api/docs`
- **Swagger JSON**: `https://homegennyserver-po5u.onrender.com/api/docs-json`
- All routes are versioned under `/api/v1/...` — a request to a path without this prefix (e.g.
  `/auth/login` instead of `/api/v1/auth/login`) returns a `404 Cannot POST ...` — this is the
  single most common integration mistake, check this first if something 404s unexpectedly.
- Every response is wrapped in a common envelope:
  ```json
  { "success": true, "data": { ... }, "timestamp": "2026-08-14T08:20:26.105Z" }
  ```
  Errors follow Nest's standard shape: `{ "statusCode": 400, "timestamp": "...", "path": "...", "message": "..." }`.
- Auth: `Authorization: Bearer <access_token>` header on every route except `login`,
  `register/*`, `forgot-password`, `verify-otp`, `reset-password`.

## 2. Auth — shared by every role

Base path: `/auth`

| Method | Route | Purpose |
|---|---|---|
| POST | `register/customer` | Self-registration — Client |
| POST | `register/staff` | Self-registration — Staff |
| POST | `login` | `{ phone, password }` → tokens + `must_change_password` flag |
| POST | `forgot-password` | Sends OTP (currently mocked, see below) |
| POST | `verify-otp` | Verifies the OTP from forgot-password |
| POST | `reset-password` | Sets a new password after OTP verification |
| POST | `change-password` | `{ otp, new_password }` — used for the forced first-login change |
| POST | `2fa/setup` / `2fa/confirm` / `2fa/reset-setup` | Optional 2FA |
| POST | `refresh` | `{ userId, refresh_token }` — **both fields required**, a common client bug is omitting `userId` |
| POST | `logout` / `logout-all` | Invalidate session(s) |
| GET | `me` | Current user's profile |

### Account provisioning & first-login flow (important context)

Whenever Admin/HR/Finance/RM creates a Staff, Client, or Employee record, a login-capable `User`
row is auto-created with:
- **Default password**: `HomeGenny@2024`
- `must_change_password: true` on that user

On first login, the `login` response includes `must_change_password: true` — the app should route
to a forced change-password screen, calling `POST /auth/change-password` with the OTP.

**OTP is currently a fixed mock value: `123456`** everywhere (forgot-password and the forced
change-password flow both use this) — this is a deliberate placeholder until a real SMS/OTP
provider is wired in. Do not build UI logic that expects a real, randomly generated OTP yet.

## 3. Demo accounts

⚠️ **These only exist on the local dev database — not on the live server
(`homegennyserver-po5u.onrender.com`).** The app connects straight to that live server, which has
its own, separate database — none of the accounts below will log in there. They're included so you
can see the *shape* of a fully-linked RM → Staff → Client chain, not as literal credentials to use
against production.

| Role | Phone | Password | Notes |
|---|---|---|---|
| Client | `9100000091` | `HomeGenny@2024` | "Mobile Demo Client" — has a real FinanceCustomer + active Placement + attendance history |
| RM | `9800000002` | `HomeGenny@2024` | "RM Demo Account" — manages the pipeline, approves shifts |
| Staff | `9911100001` | `HomeGenny@2024` | staff_code `staff001`, MAID series — deployed on the demo client's placement above |

These three accounts are linked to each other (same placement chain), so testing one role's screen
against another's data will show consistent, real results — **on local only**.

### Getting real credentials on the live server

- **Client / Staff**: self-register via `POST /auth/register/customer` or `POST /auth/register/staff`
  (see section 2) — this works against the live DB directly.
- **RM**: RM accounts aren't self-registered — ask Admin/HR to create one (Admin panel → Create
  User → role RM), which auto-provisions a login with the default password from section 2.
- Whatever staff/client account you end up testing with, remember the placement-confirm gotcha in
  section 4 — a freshly created placement is `TRIAL` until someone with RM/BM/Admin calls
  `POST /placements/:id/confirm`, and check-in/attendance/invoicing all need it to be `CONFIRMED`.

## 4. RM Mobile APIs

Base path: `/rm`. Swagger tag **"Mobile App RM APIs"** — note this tag is intentionally broad: it
also includes routes from the Verification and Video Certification controllers, and the Staff
mobile routes, because RM triggers/reviews those flows as part of managing a staff member's
pipeline. If you only want RM's *own* endpoints, use this table, not the full tag list.

| Method | Route | Purpose |
|---|---|---|
| GET | `dashboard` | KPIs — pipeline funnel, staff counts by stage |
| GET | `kanban` | Full pipeline board, staff grouped by stage |
| POST | `intake` | S1 intake — create a new staff applicant |
| POST | `pipeline/:staffId/advance` | Advance a staff member to the next pipeline stage |
| GET | `trials` | Staff currently in trial placement |
| GET | `deferred` | Deferred cases |
| POST | `deferred/:staffId/resume` | Resume a deferred case |
| GET | `terminal` | Terminated/rejected applicants |
| GET / POST | `incidents` | List / file incidents |
| GET | `shifts` | Shift logs pending/reviewed |
| PATCH | `shifts/:id/review` | Approve/reject/flag a shift log — `{ action: "APPROVED"|"REJECTED"|"FLAGGED", notes? }` |
| GET | `upgrades` | Series/role upgrade requests |
| GET | `locations` | Staff GPS/location data |
| GET / PUT | `attendance` | Read/mark daily attendance |
| GET | `attendance/:staffId/invoice-preview` | Preview payroll calc before running it |
| POST | `attendance/:staffId/generate-invoice` | Trigger invoice generation for a placement |

Also relevant to RM (separate controllers, same "Mobile App RM APIs" tag):
- `POST /verification/aadhaar` — trigger mock Aadhaar eKYC (mock mode is automatic — no live
  Sarathi/UIDAI integration yet, deterministic mock responses)
- `PUT /trainer/video-certifications/:id/review` — **note: this is TRAINER/ADMIN-only, not RM**,
  despite living under the RM tag — a known spec/implementation gap, not yet reconciled.
- `POST /placements` / `GET /placements` / `POST /placements/:id/confirm` / `POST /placements/:id/exit`
  — links a staff member to a client. **Important**: `POST /placements` always creates the
  placement as `TRIAL` — you must call `POST /placements/:id/confirm` afterwards to move it to
  `CONFIRMED` before the staff can check in, RM can mark attendance, or Finance can run
  payroll/invoicing for it (all three require `CONFIRMED`). `confirm` 400s if called on anything
  other than a `TRIAL` placement.

### Where `staff_id` / `client_id` come from for `POST /placements`

These should never be typed in by hand — they come from a "select from list" screen, same as any
normal app:

- **`staff_id`** — this is a `StaffApplicant.id`, **not** the staff's login `user.id`. Get it from
  the `id` field of any staff row returned by `GET /rm/kanban`, `GET /rm/dashboard`, or
  `GET /rm/trials` — the RM app should show a staff picker (search by name/staff_code) backed by
  one of these, and capture the selected row's `id`.
- **`client_id`** — this is a `FinanceCustomer.id`, **not** the client's login `user.id`. Get it
  from the `id` field of any row returned by `GET /finance/customers` (RM has access to this route)
  — same pattern, a client picker backed by that list.
- **Common mistake** (hit live during testing): pasting the `user.id` from a login response into
  either field instead of the StaffApplicant/FinanceCustomer id. There's no foreign-key constraint
  on `placements.staff_id`/`client_id` in the database, so a wrong id is silently accepted — the
  placement looks fine (even confirms fine) but check-in/dashboard queries never find it, because
  they look up by the *real* staff's StaffApplicant.id. If a confirmed placement isn't showing up
  where expected, this mismatch is the first thing to check.

### RM app screens — Placement flow (frontend-managed gating)

The backend does **not** restrict which pipeline stage a staff must be in before a placement can
be created — `POST /placements` will accept any staff, at any stage (S1_INTAKE included). By spec,
a placement should only happen once a staff is deployment-ready (`pipeline_stage: "S5_DEPLOY"`),
so **this gate needs to live in the RM app's UI** — filter the staff picker client-side, don't rely
on the API to reject an out-of-stage staff.

**Screen 1 — Staff list / picker**
- Data source: `GET /rm/kanban` (already grouped by stage) or `GET /rm/dashboard`.
- Filter to `pipeline_stage === "S5_DEPLOY"` before showing a staff in the "Create Placement" flow
  — staff in any earlier stage shouldn't be selectable here at all (grey out or hide them).
- On selection, capture the row's `id` (StaffApplicant.id) — this becomes `staff_id`.

**Screen 2 — Client picker**
- Data source: `GET /finance/customers` (optionally `?search=` for a search box).
- On selection, capture the row's `id` (FinanceCustomer.id) — this becomes `client_id`.

**Screen 3 — Placement details form**
- Fields: `staff_salary`, `management_fee` (both numbers), optionally `trial_start_date` /
  `trial_end_date` (defaults to today / +14 days if left blank).
- Submit → `POST /placements` with `{ staff_id, client_id, staff_salary, management_fee, ... }`.
- Response comes back `status: "TRIAL"` — show this clearly (e.g. a "Trial — pending confirmation"
  badge), don't imply the staff is fully deployed yet.

**Screen 4 — Confirm action**
- Shown on the placement's detail view, only while `status === "TRIAL"`.
- A "Confirm Placement" button → `POST /placements/:id/confirm`.
- On success, `status` flips to `"CONFIRMED"` — only after this does the staff's check-in, RM's
  attendance marking, and Finance's payroll/invoicing start working for this placement. Make this
  visually obvious (e.g. don't let the RM think the job is done after step 3 alone).
- If called twice, or on a non-TRIAL placement, the API 400s with a clear message — surface that
  message directly, don't need custom copy for it.

**Screen 5 — Exit action**
- On an active (CONFIRMED) placement's detail view — "End Placement" → `POST /placements/:id/exit`
  with `{ exit_date, exit_scenario_code }`.

Summary of the state machine the UI should reflect:
```
staff reaches S5_DEPLOY (RM app should gate on this before offering "Create Placement")
        │
        ▼
POST /placements            → status: TRIAL      (visible, not yet usable by staff/RM/Finance)
        │
        ▼
POST /placements/:id/confirm → status: CONFIRMED  (staff check-in, RM attendance, invoicing all unlock)
        │
        ▼
POST /placements/:id/exit    → status: EXITED
```

## 5. Staff Mobile APIs

Base path: `/staff`. Swagger tag **"Mobile App Staff APIs"** (clean — only this controller).

| Method | Route | Purpose |
|---|---|---|
| GET | `dashboard` | Current stage, completion %, assigned RM, today's tasks |
| GET | `pipeline` | **Full 8-stage history** (not just current stage) — matches what RM sees for this staff |
| GET | `profile` | Staff's own profile |
| PUT | `profile` | Update own profile |
| GET | `deployment` | Current placement details (client name, address, salary) |
| POST | `attendance/check-in` | `{ latitude?, longitude? }` — requires a `CONFIRMED` placement, else `400` |
| POST | `attendance/check-out` | Same shape as check-in |
| GET | `attendance/history` | Last 30 shift logs |

Note: shift logs start as `PENDING` on check-in — they only count toward payroll after an RM
approves them via `PATCH /rm/shifts/:id/review`.

## 6. Client Mobile APIs

Base path: `/client`. Swagger tag **"Mobile App Client APIs"** (clean — only this controller).

| Method | Route | Purpose |
|---|---|---|
| GET | `profile` | Client's own profile (name/phone/address/city/pincode — payment fields are always null, no schema for them yet) |
| GET | `dashboard` | Placement count, today's attendance status, invoice summary |
| GET | `assigned-staff` | Staff deployed at this client |
| GET | `staff/:id/profile` | Detail view — verification status, PV status, series |
| GET | `attendance/today` | Today's check-in/out for the assigned staff |
| GET | `attendance/history` | Last 30 shift logs |
| POST | `attendance/raise-issue` | `{ message, staff_id?, title? }` — files a real Incident, `staff_id` defaults to the active placement's staff if omitted |
| GET | `invoices` | Real `client_invoices` rows — **empty until an RM approves the shift + Finance runs payroll** for that period, this is expected, not a bug |
| POST | `complaints` | **Multipart form** — `{ subject, description, images[]? }` — matches the Flutter app's exact call shape; `staff_id`/`type`/`title` are optional overrides |
| POST | `replacements` | ⚠️ Placeholder only — no `Replacement`/`ExitRequest` schema exists yet, always returns a canned "under review" response |

### Known gaps (be aware, not blockers)

- `IncidentType` only has 6 values right now (`CLIENT_COMPLAINT`, `STAFF_MISCONDUCT`,
  `SAFETY_ISSUE`, `ATTENDANCE_FRAUD`, `DRIVING_VIOLATION`, `LATE_EXIT`) — extending it is blocked
  on a Postgres enum-owner permission, not yet resolved.
- `POST /client/replacements` has no backing data model — deferred to a follow-up pass.
- The Flutter app's own `ClientRepositoryImpl` only wires `remote:` calls for 3 of these 10 routes
  today (`dashboard`, `profile`, `complaints`) — the rest exist and are tested here, but need the
  app's repository layer wired to them before they'll actually be called from the UI.

## 7. How to test

1. Open the Swagger UI: `https://homegennyserver-po5u.onrender.com/api/docs`.
2. `POST /auth/login` with any demo account phone/password from section 3.
3. Copy `access_token` from the response.
4. Click **Authorize** (top right) and paste the token.
5. Call any route — filter by tag (`Mobile App Auth APIs` / `Mobile App RM APIs` /
   `Mobile App Staff APIs` / `Mobile App Client APIs`) to narrow the list.

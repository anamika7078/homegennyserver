# Mobile app change needed — Staff and Client self-registration

## What changed on the backend (already live)

Two endpoints, both public (no token needed), both throttled to **5 requests/min
per IP** — same bucket as `/auth/login`, so don't retry-loop on a 429, back off
and show a message instead. As of 2026-09-28, nothing in the Flutter app calls
either one yet — both need a signup screen built from scratch, even the
customer one whose backend has been live for a while.

### `POST /auth/register/customer` — backend unchanged, was already live

Creates the login **and** a `finance_customers` row in one step — the client
shows up in Finance's customer list immediately, and any RM can place staff
against them from then on (no equivalent of the staff side's "claim" step —
clients aren't RM-owned, so there's nothing to assign).

**What happens after a client registers — verified against the live code,
2026-09-28:**

- The customer list every RM's client picker reads from
  (`customer.service.ts` `listCustomers()`, `GET /finance/customers`,
  reachable by RM/BM/Finance/Admin) has no RM or branch filter at all, and
  orders `ORDER BY created_at DESC` — a client who just registered is not
  just visible, they're the **first result** an RM sees.
- Creating a placement (`POST /placements`, `placement.service.ts create()`)
  runs several checks on the **staff** being placed (must already be at
  S5_DEPLOY, no open stage holds, not already placed with this same client) —
  and **none at all on the client**. No approval state, no verification
  step, no PAN-confirmed flag — a `client_id` from a customer that registered
  ten seconds ago is accepted exactly like one Finance onboarded manually
  months ago.
- That's why there's no "claim" step here unlike the staff side: staff
  visibility is scoped by `assignedRmId` (null until claimed), but the
  client list was never scoped by RM to begin with — every RM already sees
  every client. Nothing had to be built for this to work; it already did.
- One rough edge, not a blocker: `client_id` on `POST /placements` isn't even
  checked for existence — a typo'd id would silently create a placement
  against nothing rather than 404. Only RM/BM/Admin can call that endpoint,
  so it's a minor robustness gap, not something the app needs to guard
  against.

#### Request body

```json
{
  "full_name": "Anita Sharma",
  "phone": "9811100001",
  "email": "anita@example.com",
  "password": "Str0ng@Pass1",
  "business_name": "Sharma Residence",
  "pan_card": "ABCDE1234F",
  "address": "B-12, Sector 44, Noida",
  "city": "Noida",
  "state": "Uttar Pradesh",
  "pincode": "201301",
  "gstn": "09ABCDE1234F1Z5"
}
```

| Field | Required | Rule |
|---|---|---|
| `full_name` | yes | 2–200 chars |
| `phone` | yes | 10–15 digits, `+` optional |
| `email` | no | valid email |
| `password` | yes | same rule as staff — 8–72 chars, upper + lower + digit + one of `@ $ ! % * ? & # - _` |
| `business_name` | no | up to 255 chars — shown as the customer name if given; falls back to `full_name` if left blank (a household hiring for personal use has no business name) |
| `pan_card` | **yes** | up to 20 chars — PAN is required for a client, unlike a staff member |
| `address` | yes | up to 2000 chars |
| `city` / `state` / `pincode` | no | free text |
| `gstn` | no | up to 50 chars — only relevant if `business_name` is a registered business |

No `series`/category field on this form — that's a staff-only concept.

#### Success response — 201

Same `LoginResponse` shape as staff registration and as login, with
`"role": "CLIENT"`. If the app already has code that takes a login response
and signs the user in (saves tokens, navigates to the home screen), reuse it
as-is here — there's no new response-handling to write for either endpoint.

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "must_change_password": false,
  "user": {
    "id": "uuid",
    "full_name": "Anita Sharma",
    "role": "CLIENT",
    "phone": "9811100001",
    "is_active": true,
    "branch_id": null
  }
}
```

#### One error specific to this endpoint

On top of the shared 400/409/429 cases in the table further down, a duplicate
PAN also throws 409 — checked case-insensitively (`ABCDE1234F` and
`abcde1234f` collide; verified live), message echoing back exactly whatever
PAN was submitted:

```json
{ "message": "Customer with PAN ABCDE1234F already exists", "statusCode": 409 }
```

There is no 403/restricted-list case here — that check only applies to the
staff being placed, not the household hiring them.

### `POST /auth/register/staff` — newly enabled (2026-09-28)

This used to always return 400 ("staff do not self-register"). That's gone.
It now creates a real login **and** a real `staff_applicants` row — the same
entity the RM's pipeline runs on — and immediately advances it past S1_INTAKE
to S2_VERIFY, because registering IS the intake step: name, phone, DOB,
address, category is everything S1 needs.

There is no RM assigned yet (self-registration has none to assign) — that's
handled entirely on the web/RM side (`GET /rm/unassigned-staff`, a "New Leads"
list any RM can claim from) and needs **nothing from the app**. Don't build a
"waiting for RM" screen gated on this — it's invisible to the applicant, and
S2 verification can proceed with no RM assigned; only a few RM-scoped actions
need one, later in the pipeline.

#### Request body

```json
{
  "full_name": "Pooja Mishra",
  "phone": "9811100002",
  "alternate_phone": "9811100099",
  "email": "pooja@example.com",
  "password": "Str0ng@Pass1",
  "date_of_birth": "1995-06-15",
  "gender": "FEMALE",
  "address": "C-45, Sector 62, Noida",
  "city": "Noida",
  "state": "Uttar Pradesh",
  "pincode": "201301",
  "series": "MAID"
}
```

| Field | Required | Rule |
|---|---|---|
| `full_name` | yes | 2–200 chars |
| `phone` | yes | 10–15 digits, `+` optional |
| `alternate_phone` | no | same format as `phone` |
| `email` | no | valid email |
| `password` | yes | 8–72 chars, at least one uppercase, one lowercase, one digit, one of `@ $ ! % * ? & # - _` |
| `date_of_birth` | yes | ISO date string (`YYYY-MM-DD`) |
| `gender` | yes | `MALE` \| `FEMALE` \| `OTHER` |
| `address` | yes | up to 2000 chars |
| `city` / `state` / `pincode` | no | free text |
| `series` | **yes — new field** | one of `MAID`, `SC`, `UC`, `DR` (see picker copy below) |

`series` is the one field this flow didn't collect before. It's the person's
work category and it drives which S2 verification checks and video-cert
prompts apply from here on — get it right at signup; an RM can correct it
later if needed, but that's a manual fix, not automatic. Suggested picker
copy:

| Value | Label to show |
|---|---|
| `MAID` | Maid / Domestic Help |
| `SC` | Skilled Care (Nurse, Attendant) |
| `UC` | Unskilled Care (Helper, Security) |
| `DR` | Driver |

`RegisterCustomerDto` (the client endpoint above) does **not** have a
`series` field — don't add a category picker to the client signup form.

#### Success response — 201

Same `LoginResponse` shape, `"role": "STAFF"`.

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "must_change_password": false,
  "user": {
    "id": "uuid",
    "full_name": "Pooja Mishra",
    "role": "STAFF",
    "phone": "9811100002",
    "is_active": true,
    "branch_id": null
  }
}
```

Neither endpoint ever returns the `requires_2fa` / `requires_totp_setup`
shapes login can return for ADMIN — STAFF and CLIENT never hit 2FA.
Registration always returns tokens straight away, or an error; no branching
needed for that.

## Error responses — shared by both endpoints

| Status | When | Message shape |
|---|---|---|
| `400` | A field fails validation (see the field tables above) | `{ "message": ["<field> <rule>", ...], "error": "Bad Request", "statusCode": 400 }` — `class-validator`'s array-of-strings format; show the first one |
| `409` | Phone or email already has an account (customer: also a duplicate PAN, see above) | `{ "message": "An account with this phone number or email already exists", ... }` — send them to Login instead |
| `403` | **Staff only** — phone/Aadhaar-adjacent match on the restricted list | `{ "message": "Intake blocked — this applicant matches the restricted list (...)." }` — show a generic "couldn't complete registration, contact your nearest branch" message; don't surface the reason text |
| `429` | Rate limit (5/min/IP, shared with login) | show "try again in a minute", don't auto-retry |

## What this doesn't change on the app

- Login screen, token storage, refresh flow — untouched.
- No new "pending approval" / "waiting for review" state for staff — they're
  live in the pipeline the instant they register, same as an RM-run intake.
- No UI needed for RM assignment — that's a backend/web-only concept
  (`assigned_rm_id`); the app never reads or shows it.

## Files, if useful for reference

- `homegennyserver/src/modules/auth/auth.controller.ts` — both endpoints
- `homegennyserver/src/modules/auth/auth.service.ts` — `registerStaff`,
  `registerCustomer`
- `homegennyserver/src/modules/auth/dto/register-staff.dto.ts` — the exact
  validators
- `homegennyserver/src/modules/auth/dto/register-customer.dto.ts`

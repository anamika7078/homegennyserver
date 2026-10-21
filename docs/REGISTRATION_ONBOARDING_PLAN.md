# Registration & Onboarding — Mobile Login, Then Complete Your Profile

**21 Oct 2026 · Built 2026-10-21** (backend, RM web, mobile brief `docs/MOBILE_BRIEF_ONBOARDING.md`; `npm run test:onboarding`). Replaces the "RM fills S1" and "client names themselves
inside the first request" parts of the 2026-10-21 mobile-only sign-up (`MOBILE_BRIEF_MOBILE_ONLY_REGISTRATION.md`).
The mobile + OTP login itself stays as built.

## The flow

```
Mobile number → OTP (fixed 123456 for now, by decision) → inside the app
        │
        ▼
"Complete your profile" (home is visible; every action is locked until done)
        │
   ┌────┴──────────────────────────────┐
 STAFF                                CLIENT
 submits profile                      submits profile
  → checks (age, restricted list)      → "Request staff" unlocks
  → S1 done → S2 Verification          → requests route by the client's city
  → RM assigned automatically
    (branch from city, fewest staff)
  → RM notified; no match → Leads
```

## Decisions (2026-10-21)

1. Staff profile submit moves the staff **straight to S2**. No RM approval step; the RM is notified.
2. **RM auto-assigned**: the branch comes from the city; the RM there with the fewest active staff gets them. No
   branch or no RM there → stays unassigned in **Leads**, and BMs/Admins are notified.
3. Staff profile fields as listed below. **No photo for now.**
4. Client profile: name, address, city, pincode. **PAN/GST not asked**; RM/Finance collect them later.
5. Gate: the **home is visible, actions are locked** until the profile is complete. Enforced on the server, not
   only in the app.

## What is wrong today (found 2026-10-21, live on homegenny.com)

| Problem | Where |
|---|---|
| A new staff member's profile shows **"Pooja Mishra", "Maid", "STF-1029", "S2_VERIFY"**: demo fallbacks fill every blank field. The DB row is correct (blank). | `GET /staff/profile`, `GET /staff/dashboard` |
| "2 tasks to do" and RM "Amit Gupta" are hard-coded | `GET /staff/dashboard` |
| Login response: `staffCode: 'STF-1029'`, `assignedRm: Amit Gupta`, client `activePlacements: 1` hard-coded | `AuthService.login` |
| `PUT /staff/profile` only saves address and email | staff-mobile controller |
| Nothing stops an incomplete account from using the app | everywhere |
| New staff are never given an RM | registration |
| Client names themselves inside the first request: two paths to the same data | `POST /client/staff-requests` `profile` block |

"Pending profile" / 1995-01-01 / "Delhi NCR" placeholders reported by the app side are **not** in the backend or the
app on GitHub, and not in the server data. Check the mobile dev's local code.

---

## Part A — Backend

### A1. Remove the fake fallbacks
- `GET /staff/profile`, `GET /staff/dashboard`, `AuthService.login` (STAFF and CLIENT role meta),
  `GET /client/dashboard` and anything else returning demo literals (`Pooja Mishra`, `MAID`, `STF-1029`,
  `S2_VERIFY`, `Amit Gupta`, `Sector 62, Noida`, `1996-05-15`, `activePlacements: 1`, hard-coded tasks).
- Return the real value or `null` / `[]`. `assignedRm` = the real RM (name + phone) or `null`.
- Dashboard tasks: real pending items derived from the pipeline (e.g. "Complete your profile",
  "Upload police verification" when that track is pending), or `[]`.

### A2. Onboarding status — one place the app asks "what next?"
`GET /me/onboarding` (CLIENT and STAFF):
```json
{ "role": "STAFF", "profile_complete": false,
  "missing": ["full_name", "date_of_birth", "gender", "series", "address", "city", "pincode", "emergency_contact"],
  "next_step": "COMPLETE_PROFILE",
  "rm": null }
```
`next_step`: `COMPLETE_PROFILE` → `WAIT_FOR_RM` (staff, S2 with no RM yet) → `VERIFICATION` (staff at S2) →
`READY`. For a client: `COMPLETE_PROFILE` → `READY`. The same `profile_complete` / `profile_missing` stay on the
login response and `/user/profile`.

### A3. Serviceable cities
`GET /meta/cities` (public): the cities of active branches, plus their area names (from `branches` and
`branch-areas.config`), e.g. `[{ "city": "Delhi NCR", "areas": ["Gurgaon","Noida","South Delhi"] }, { "city": "Pune", … }]`,
and `"Other"`. The app shows a dropdown, so city → branch is exact, not a guess from free text.

### A4. Staff profile = S1
`PUT /staff/profile` takes the full S1 set; `POST /staff/profile/submit` completes it.

| Field | Rule |
|---|---|
| `full_name` | required, 2–200 |
| `date_of_birth` | required, YYYY-MM-DD, **18–65 years** |
| `gender` | required, MALE / FEMALE / OTHER |
| `series` | required, UC / SC / CK (active series only) |
| `address` | required, 5+ chars |
| `city` | required, from `/meta/cities` (or "Other") |
| `area` | optional, from the city's areas |
| `pincode` | required, 6 digits |
| `emergency_contact_name`, `emergency_contact_mobile` | required, 10-digit mobile, not the staff's own number |
| `languages` | optional, list (Hindi, English, Marathi, …) |
| `alternate_phone`, `email`, `experience_years` | optional |

- `PUT` saves a draft (any subset). The app can save as the user goes.
- `POST …/submit` checks every required field, runs the **restricted-list check** (phone), then in one transaction:
  writes the S1 fields, renames the provisional `newNNN` code from the name, sets `users.full_name`, **advances
  S1 → S2** (`reasonCode: SELF_COMPLETED`), and **auto-assigns an RM** (A5).
  Restricted hit → TERMINAL / DENIED, as the RM intake does; the app shows "Please contact HomeGenny".
- **After S2 starts**, name, DOB, gender and category are locked (S2 checks them against Aadhaar); `PUT` refuses
  them with "Ask your RM to change this". Address, emergency contact, languages and email stay editable.
- The RM web **Complete S1** (built 2026-10-21) stays as the fallback for people who can't fill the form; it now
  calls the same submit logic, so both paths behave the same.

### A5. RM auto-assignment
On staff submit:
1. Branch: the branch whose city matches `city` (Delhi NCR / New Delhi → Delhi HQ, Pune, Mumbai). "Other" → none.
2. RM: active RMs of that branch; pick the one with the **fewest active staff** (assigned, not TERMINAL); tie → the
   longest since their last assignment.
3. Set `assigned_rm_id` + `branch_id`, write a `STAFF_AUTO_ASSIGNED` pipeline event, and notify the RM ("New staff
   ready for verification: <name>, <phone>").
4. No branch or no RM there → stay unassigned (shown in **Leads**), notify that branch's BMs or the Admins.

Today on homegenny.com only Delhi has an RM, so Pune/Mumbai sign-ups land in Leads until RMs exist there.

### A6. Client profile = gate for requests
- Required: `full_name`, `address`, `city` (from `/meta/cities` or Other), `pincode`. Map pin (`lat/lng`) optional,
  but asked for by the app. Email optional. PAN/GST not asked.
- `PATCH /client/profile` (built) gains `city`/`pincode` as required for completeness; `missing` reflects that.
- `POST /client/staff-requests` refuses an incomplete client with **403 `PROFILE_INCOMPLETE`**. The inline
  `profile` block is **removed**: one path only. The request's own address can still differ from the home address.
- The client's city sets the branch the request goes to (fixes requests landing with no branch / no RM).

### A7. The gate on the server
For a CLIENT or STAFF with `profile_complete = false`:
- **Every GET works** (returns real, possibly empty, data) so the home screen renders.
- **Writes are refused** with 403 `{ error: "PROFILE_INCOMPLETE", missing: [...] }`, except an allowlist:
  auth (logout, refresh, OTP), `PUT/POST /staff/profile…`, `PATCH /client/profile`, notifications read, device token.
- Implemented as one global guard after the auth guard, so a new endpoint is gated by default.

### A8. Existing accounts
No migration: the columns are already nullable. `new001` / `new002` on the server and any other half-filled
accounts get the wizard on their next login. Staff who reached S2 the old way (complete profile) are unaffected.

## Part B — RM web
- **Leads → Staff**: shows sign-ups still filling their profile (read-only "Profile in progress", with the phone to
  call) and the unassigned ones (no RM in their city). "Complete S1" stays for the fallback.
- **Staff detail**: "Auto-assigned on <date>" line from the pipeline event.
- **Notifications**: the "new staff ready for verification" item links to the staff page.
- Staff Snapshot: unchanged; S2 staff count under "In pipeline".

## Part C — Mobile app (brief: `docs/MOBILE_BRIEF_ONBOARDING.md`)
- After login, read `GET /me/onboarding`. `COMPLETE_PROFILE` → open the profile wizard. The home stays reachable,
  but every action button shows "Complete your profile first" (and the server refuses anyway).
- **Staff wizard** (3 steps): About you (name, DOB, gender, category) → Where you live (city dropdown, area,
  address, pincode) → Emergency contact & languages → Review → Submit. Drafts saved with `PUT` per step.
  After submit: "You're in! Your RM <name> will call you" or "We'll assign an RM soon" (`WAIT_FOR_RM`).
- **Client wizard** (2 steps): name → home (city dropdown, address, pincode, map pin) → Done → Request staff.
- Remove the "Your name" field from the Request Staff form (from the earlier brief).
- Profile screens: show real values or "Not added"; locked fields show a lock and "Ask your RM".
- Error `PROFILE_INCOMPLETE` anywhere → route to the wizard.

## Part D — Tests
`npm run test:onboarding`: fallbacks gone (blank fields come back null), `/me/onboarding` steps, draft save, submit
validation (age, pincode, emergency number ≠ own), restricted hit → TERMINAL, S1 → S2 on submit, RM auto-assign
(fewest staff, branch match, no-RM fallback → Leads + BM notified), locked fields after S2, client request refused
until complete, the gate (GET allowed, write refused, allowlist works), RM "Complete S1" uses the same path.
Plus `test:registration`, `test:requests`, `test:rm`, `test:snapshot` as regression.

## Order

| Step | What | Size |
|---|---|---|
| 1 | A1 fallbacks out | small |
| 2 | A2 onboarding status, A3 cities | small |
| 3 | A4 staff profile + submit + locks, A5 auto-assign | medium |
| 4 | A6 client gate, A7 global gate | medium |
| 5 | Part B RM web | small |
| 6 | Tests, mobile brief, deploy (backend + frontend; no migration) | medium |

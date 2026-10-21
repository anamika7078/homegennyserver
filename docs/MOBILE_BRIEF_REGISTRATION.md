# Mobile App Brief — Registration: Mobile Login, Then "Complete Your Profile"

**21 Oct 2026 · For the Flutter app (checked against `homegennyapp` main @ `fc9f9d3`).** This is the one document
for registration. It replaces *Sign-in and Sign-up with a Mobile Number Only* and *Login, Then "Complete Your
Profile"*; you can drop both.

**The flow**
1. A new user enters **only their mobile number** and logs in with an OTP.
2. Inside the app they **complete their profile**.
   - **Staff:** submitting the profile finishes Stage 1. Verification (Stage 2) starts, and an RM is assigned automatically.
   - **Client:** the profile unlocks "Request staff".
3. Until the profile is complete, the **home is visible but every action is locked**. The server refuses actions too.

Everything below is built on the backend, live on homegenny.com, and tested against live API calls
(`npm run test:onboarding`, `npm run test:registration`).

**Common rules (same as the other briefs)**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>", … } }`. Show `message.message` as it is.
- All app text is English.

> ⚠️ **The OTP is a fixed code for now: `123456`.** No SMS is sent yet. Build the screen as if a real SMS
> arrives (6-digit field, resend timer). **Don't hard-code 123456 in the app**; when SMS is added, only the
> backend changes.

## What changes, and on which screen

| What changes | App screen | Section |
|---|---|---|
| Login with **mobile + OTP**. No password field. | Login, OTP | §1, §2 |
| A new number picks **"Client or Staff?"**, then signs up on the same flow | Login / OTP | §1 |
| **Register screen: remove all fields.** "Register" just opens the mobile login. | Register | §3 |
| Remove the old "password → `/auth/verify-otp`" step and "Forgot password?" | Login, OTP | §3 |
| After login, ask **`GET /me/onboarding`** what to show | After OTP / app start | §4 |
| **403 `PROFILE_INCOMPLETE`** on any action → open the profile wizard | Everywhere | §4 |
| City is a **dropdown** from `GET /meta/cities` | Both wizards | §5 |
| **Staff profile wizard**: 3 steps + Submit | Staff | §6 |
| Staff home: **real RM, real tasks**, no demo data | Staff home, profile | §7 |
| **Client profile wizard**, then Request Staff | Client | §8 |

---

## 1. Login flow

```
Login screen: [ +91 | mobile number ]   [Continue]
        │  POST /auth/otp/send
        ▼
  use_password_login = true ──► "This number is for an office account. Please use the HomeGenny web portal."
        │
  is_registered = false ──► "I am a…  ( Client | Staff )"   (bottom sheet or two big cards)
        ▼
OTP screen: [ 6 digits ]   Resend in 00:30
        │  POST /auth/otp/verify  { phone, otp, role? }
        ▼
  save tokens exactly like a login today ─► GET /me/onboarding (§4)
```

- Ask "Client or Staff?" **only when `is_registered` is false**. A known number already has a role; the server
  ignores a different `role` and signs in as the real one.
- Ask the role before the OTP screen (recommended) or on it; send it in `/auth/otp/verify` either way.
- Picked the wrong role? There is no switch in the app; the RM/Admin fixes it.
- Don't ask for a name or category here. The profile wizard (§6, §8) asks for everything.

## 2. API: login

### 2.1 `POST /auth/otp/send` (public)
```json
{ "phone": "9876543210" }
```
```json
{ "sent": true, "expires_at": "2026-10-21T07:28:28.291Z",
  "is_registered": false, "role": null, "use_password_login": false }
```
| Field | Meaning |
|---|---|
| `is_registered` | The number already has an account. |
| `role` | `"CLIENT"` or `"STAFF"` for an app account, else `null`. |
| `use_password_login` | `true` = an office number (RM/BM/Admin/HR). OTP login is refused; show the §1 message. |

- The code is valid **10 minutes**. "Resend" calls `/auth/otp/send` again; the new code replaces the old one.
- Send the 10 digits. `+91…` / `91…` are accepted.
- Rate limit: 10 calls/min per IP for send + verify together. On 429: "Too many attempts, try again in a minute".

### 2.2 `POST /auth/otp/verify` (public)
```json
{ "phone": "9876543210", "otp": "123456", "role": "STAFF" }
```
`role` is required **only for a new number**.

The response has the **same shape as `POST /auth/login`**, plus `is_new_user`:
```json
{ "access_token": "…", "refresh_token": "…", "must_change_password": false, "is_new_user": true,
  "user": { "id": "…", "full_name": "", "role": "STAFF", "phone": "9876543210", "is_active": true, "branch_id": null,
            "staffCode": "new004", "pipelineStage": "S1_INTAKE", "series": null, "assignedRm": null,
            "profile_complete": false,
            "profile_missing": ["full_name", "date_of_birth", "gender", "series", "address", "city", "pincode", "emergency_contact"] } }
```
A client's `user` has `customerCode`, `customerName` (`null` until they give a name), `activePlacements`,
`profile_complete` and `profile_missing` (`["name","address","city","pincode"]` for a new one).

| Status | `message.message` | What the app does |
|---|---|---|
| 401 | `Incorrect OTP.` | Let them retry. After 5 wrong tries the code is cancelled; they must resend. |
| 400 | `This OTP has expired — request a new one.` | Enable "Resend". |
| 400 | `This number is not registered yet — send role: CLIENT or STAFF to sign up.` | Ask the role, then verify again **with the same code** (it stays valid). |
| 403 | `This number belongs to an office account — sign in with your password.` | Show the §1 message. |
| 403 | `This number cannot be registered. Please contact HomeGenny.` | Restricted list. Show as is. |

- `must_change_password` is always `false` for these accounts. Never open Change Password for them.
- `user.full_name` can be `""` until the profile is done. Wherever a name is shown, fall back to the phone or "Welcome".
- Refresh, logout and biometric unlock work as today.

## 3. What to remove or change

- **Register screen:** remove every field. Route `/register` to the login screen; keep `?role=staff|client` to
  pre-select the role. The old `POST /auth/register/*` endpoints still work for old app versions, but the new app
  must not call them.
- **Login screen:** remove the password field and "Forgot password?" (app users have no password). "Register" does
  the same as Continue.
- **OTP screen:** today it runs after a password login and calls `POST /auth/verify-otp`. That endpoint is for
  **password reset only**; it signs no one in. Point the screen at `POST /auth/otp/verify` and make it the step that
  saves the tokens. Remove the hard-coded `'+1 (555) 019-2834'` placeholder.
- **Request Staff:** if you built the "Your name" field / `profile` block from an earlier draft, remove it (§8).

## 4. After login: `GET /me/onboarding` and the gate

Call `GET /me/onboarding` (CLIENT, STAFF) right after login, on app start, and after a profile save or submit:
```json
{ "role": "STAFF", "profile_complete": false,
  "missing": ["full_name", "date_of_birth", "gender", "series", "address", "city", "pincode", "emergency_contact"],
  "next_step": "COMPLETE_PROFILE", "pipeline_stage": "S1_INTAKE", "rm": null }
```

| `next_step` | Who | Show |
|---|---|---|
| `COMPLETE_PROFILE` | both | The profile wizard. The home stays reachable; every action button says "Complete your profile first". |
| `WAIT_FOR_RM` | staff | Home card: "Profile submitted. We'll assign your RM soon." |
| `VERIFICATION` | staff | Home card: "Your RM `rm.name` (`rm.phone`) will call you to verify your documents." |
| `READY` | both | The normal app |

`profile_complete` / `profile_missing` are also on the login response and on `GET /user/profile`.

**The gate.** Until the profile is complete, **every GET works** (screens load, mostly empty). **Every
POST/PUT/PATCH is refused**, except the profile routes, logout/refresh and marking notifications read:
```json
{ "statusCode": 403, "message": { "statusCode": 403, "error": "PROFILE_INCOMPLETE",
  "message": "Complete your profile first — date_of_birth, city missing.", "missing": ["date_of_birth", "city"] } }
```
On `message.error == "PROFILE_INCOMPLETE"` anywhere → open the wizard at the first missing step.

## 5. `GET /meta/cities` (public): the city dropdown

```json
{ "cities": [
  { "city": "Delhi NCR", "areas": ["Gurgaon", "Noida", "South Delhi"] },
  { "city": "Pune", "areas": ["Baner", "Karver Nagar", "Moshi"] },
  { "city": "Mumbai", "areas": ["Andheri", "Bandra"] },
  { "city": "Other", "areas": [] } ] }
```
- City is a **dropdown**, never free text: it decides the branch and the RM. Area is an optional second dropdown
  when the city has areas.
- "Other" is allowed: the user is registered, but no RM is assigned automatically.

## 6. Staff profile

### 6.1 `GET /staff/profile`
Real values only. **A blank is `null`**; there is no "Pooja Mishra", "Maid" or "STF-1029" any more.
```json
{ "id": "…", "staffApplicantId": "…", "staffCode": "new004", "fullName": null, "mobile": "9876543210", "email": null,
  "series": null, "pipelineStage": "S1_INTAKE", "address": null, "dateOfBirth": null, "gender": null,
  "city": null, "area": null, "pincode": null, "emergencyContactName": null, "emergencyContactMobile": null,
  "languages": [], "alternatePhone": null, "experienceYears": null,
  "profile_complete": false, "missing": ["full_name", "…"], "locked_fields": [] }
```
`dateOfBirth` is `YYYY-MM-DD`. Show "Not added" for nulls.

### 6.2 The wizard: 3 steps + review

| Step | Fields | Rules (the server checks the same) |
|---|---|---|
| **1. About you** | Full name · Date of birth · Gender · Work category | name 2–200 chars · age **18–65** · MALE/FEMALE/OTHER · UC/SC/CK (labels from `GET /meta/series`) |
| **2. Where you live** | City (dropdown) · Area (optional) · Address · Pincode | 6-digit pincode, not starting with 0 · address 5+ chars |
| **3. Emergency contact** | Name · Mobile · Languages (multi-select, optional) · Experience in years (optional) | 10-digit mobile, **not your own number** |
| **Review** | Everything, with "Edit" per step | then **Submit** |

No photo for now.

### 6.3 Saving and submitting
- **Each step's Next** → `PUT /staff/profile` with that step's fields (any subset). The response is the same as GET.
  A 400 is a field error; show `message.message` under the form.
- **Submit** → `POST /staff/profile/submit` with the whole form. The server saves it, then checks everything required:
```json
{ "full_name": "Geeta Kumari", "date_of_birth": "1990-06-15", "gender": "FEMALE", "series": "UC",
  "address": "12 Malviya Nagar", "city": "Delhi NCR", "area": "South Delhi", "pincode": "110017",
  "emergency_contact_name": "Mohan", "emergency_contact_mobile": "9811122233", "languages": ["Hindi", "English"] }
```
Response (201):
```json
{ "outcome": "ADVANCE_S2", "assigned": { "id": "…", "name": "Pooja Mishra" },
  "role": "STAFF", "profile_complete": true, "missing": [], "next_step": "VERIFICATION",
  "pipeline_stage": "S2_VERIFY", "rm": { "name": "Pooja Mishra", "phone": "9800000002" } }
```
- `assigned: null` + `next_step: "WAIT_FOR_RM"` → no RM in that city yet. That's fine; the office assigns one.
- `outcome: "RESTRICTED"` → show `message` ("We could not complete your registration. Please contact HomeGenny.") and stop.
- 400 with `message.error == "PROFILE_INCOMPLETE"` and `message.missing` → jump to the step of the first missing field.

### 6.4 After Submit
Success screen: "You're in! Your RM **{rm.name}** will call you on {mobile} to verify your documents." For
`WAIT_FOR_RM`: "Profile submitted. We'll assign your RM soon." Then go to the staff home.

### 6.5 Editing later
After Submit, `locked_fields` = `["full_name", "date_of_birth", "gender", "series"]`. Show a lock icon and "Ask your RM
to change this"; `PUT` refuses them with a 400. Everything else stays editable with `PUT /staff/profile`.

## 7. Staff home: real data only

`GET /staff/dashboard`:
```json
{ "staffCode": "geeta001", "fullName": "Geeta Kumari", "series": "UNSKILLED_CARE", "pipelineStage": "S2_VERIFY",
  "completionPct": 17, "profileComplete": true,
  "assignedRm": { "name": "Pooja Mishra", "phone": "9800000002" },
  "todayTasks": [ { "id": "AADHAAR_EKYC", "title": "Verify your Aadhaar", "done": false },
                  { "id": "POLICE_VERIFICATION", "title": "Police verification", "done": false } ] }
```
- `assignedRm` is `null` until an RM is assigned → "RM not assigned yet". Never show a made-up name.
- `todayTasks` comes from the pipeline. A new user gets `[{ "id": "profile", "title": "Complete your profile" }]`
  (tap → wizard). It can be `[]`.
- The login response's `staffCode`, `series`, `pipelineStage` and `assignedRm` follow the same rule: real or `null`.
- `series` can be `null` before the profile is done. Anywhere you map series to a label or colour, handle null ("—").

## 8. Client profile, then Request Staff

**Wizard (2 steps):** 1. Your name → 2. Your home: City (dropdown) · Address · Pincode · map pin. Email optional.
Don't ask for PAN or GST; the RM or Finance collects them.

Save with `PATCH /client/profile`. `ClientPersonalDetailsScreen` and `ClientAddressScreen` call a dummy API
today; wire them to this:
```json
{ "full_name": "Anil Arora", "address": "5 Hauz Khas", "city": "Delhi NCR", "pincode": "110016",
  "lat": 28.5494, "lng": 77.2001, "email": "anil@example.com" }
```
- Every field is optional; only the fields you send change. `name` works as an alias of `full_name`.
- City must come from `GET /meta/cities` (400 otherwise). Pincode 6 digits.
- **The phone can't be changed** (it is the login): make it read-only and don't send it.
- `pan_card` and `gstn` are accepted, but don't add them to the app.

`GET /client/profile` (and the PATCH response):
```json
{ "name": null, "email": null, "phone": "9876543210", "address": null, "city": null, "state": null, "pincode": null,
  "lat": null, "lng": null, "pan_card": null, "gstn": null, "self_registered": true,
  "profile_complete": false, "profile_missing": ["name", "address", "city", "pincode"],
  "payment_method": null, "account_last4": null, "upi_id": null }
```
`name` is `null` until given; show "Add your name", not a blank.

**Request Staff** is enabled only when the profile is complete. Earlier, the server refuses with **403
`PROFILE_INCOMPLETE`**. The request form needs no name or profile fields; the request's own address can differ from
the home address.

## 9. Old app versions in users' hands
- Password login still works for anyone with a password.
- The old full register payloads are still accepted. Such a staff member stays at Stage 1 (the old app never asked
  for an emergency contact) until they update the app or the RM finishes it on the web.

## 10. Test checklist (dev server, homegenny.com)
1. New number → Continue → "Client or Staff?" → Staff → OTP `123456` → wizard opens. Home is reachable, but check-in, training etc. say "Complete your profile first".
2. Profile shows "Not added" everywhere. **No "Pooja Mishra", no "Maid".**
3. DOB making you 16 → error. Your own number as emergency contact → error.
4. City "Delhi NCR" → Submit → success screen with the RM's name; home shows the RM and "Verify your Aadhaar".
5. City "Pune" → Submit → "We'll assign your RM soon".
6. After Submit: name locked, address editable.
7. Same number again → no role question → straight in, no wizard.
8. New client → wizard → Request Staff disabled until saved; afterwards a request goes through.
9. Wrong OTP → error. An RM's number (`9800000002`) → "office account" message.

## 11. For reference: what the RM sees (web, built)
- **Leads → Staff:** sign-ups still filling their profile ("Filling profile", with what's missing), and ones with no RM
  in their city ("No RM in city"). "Complete S1" lets the RM fill the same profile on a call.
- **Leads → Clients:** client sign-ups with profile status, request count and call notes.
- The RM is notified when a staff member is assigned to them.

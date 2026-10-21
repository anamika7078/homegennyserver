# Mobile App Brief — Sign-in and Sign-up with a Mobile Number Only

**21 Oct 2026 · For the Flutter app (checked against `homegennyapp` main @ `fc9f9d3`).**

The client asked that **a new app user only enters their mobile number**. Everything else becomes part of their
profile and is filled in later:
- **Staff:** the RM calls them and fills in the rest ("Complete S1" on the RM web).
- **Client:** they fill in their name and address when they first request staff.

The backend and RM web are built and tested against live API calls (`npm run test:registration`, 65 checks).

**Common rules (same as the other briefs)**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>" } }`. Show `message.message` as it is.
- All app text is English.

> ⚠️ **OTP is a fixed code for now.** No SMS provider is wired in yet, so the backend sends nothing and the code
> is always **`123456`**. The app should still behave as if a real SMS was sent (6-digit field, resend timer).
> When the SMS provider is added, only the backend changes. **Don't hard-code 123456 anywhere in the app.**

## What changes, and on which screen

| What changes | App screen | Section |
|---|---|---|
| Sign in with **mobile number + OTP**. No password field. | Login | §1, §2 |
| A new number signs up on the same screen: after OTP, ask **"Client or Staff?"** | Login / OTP | §1, §2 |
| **Register screen: remove all fields.** The "Register" link just opens the mobile-number login. | Register | §3 |
| Remove the old "password → `/auth/verify-otp`" step and "Forgot password?" for app users. | Login, OTP | §3 |
| Every login response and `/user/profile` now carry **`profile_complete`** and **`profile_missing`**. | Routing after sign-in | §4 |
| Staff with S1 pending see a **"Profile under review — your RM will call you"** state. | Staff home, profile | §5 |
| Client's **first staff request asks for their name**. The request address becomes their home address. | Client: Request Staff | §6 |
| Client profile screens **save for real** via `PATCH /client/profile`. They are dummy today. | Client: Personal details, Address | §7 |

---

## 1. The new sign-in flow

```
Login screen: [ +91 | mobile number ]   [Continue]
        │  POST /auth/otp/send
        ▼
  use_password_login = true ──► show "This number is for an office account. Please use the HomeGenny web portal."
        │
  is_registered = false ──► ask "I am a…  ( Client | Staff )"   (bottom sheet or two big cards)
        │                     optional: "Your name" (can be left empty)
        ▼
OTP screen: [ 6 digits ]   Resend in 00:30
        │  POST /auth/otp/verify  { phone, otp, role? , full_name? }
        ▼
  save tokens exactly like a login today ─► route by user.role (§4)
```

- Ask "Client or Staff?" **only when `is_registered` is false**. For a known number, never ask. The account
  already has a role, and the backend ignores a different `role` and signs in as the real one.
- You can ask the role **before** the OTP screen (recommended) or on it. Either way, send it in `/auth/otp/verify`.
- If the user picks the wrong role, there is no switch in the app. The RM/Admin fixes it.

## 2. API

### 2.1 `POST /auth/otp/send` (public)
```json
{ "phone": "9876543210" }
```
Response:
```json
{ "sent": true,
  "expires_at": "2026-10-21T07:28:28.291Z",
  "is_registered": false,
  "role": null,
  "use_password_login": false }
```
| Field | Meaning |
|---|---|
| `is_registered` | The number already has an account. |
| `role` | `"CLIENT"` or `"STAFF"` when it is an app account, else `null`. |
| `use_password_login` | `true` = RM / BM / Admin / HR number. OTP sign-in is refused for these; show the message from §1. |

- The code is valid for **10 minutes**. "Resend" just calls `/auth/otp/send` again; the new code replaces the old one.
- Phone: send the 10 digits. `+91…` / `91…` are accepted and stored as the 10 digits.
- Rate limit: 10 calls/min per IP for send + verify together. On 429, show "Too many attempts, try again in a minute".

### 2.2 `POST /auth/otp/verify` (public)
```json
{ "phone": "9876543210", "otp": "123456", "role": "STAFF", "full_name": "Rekha Devi" }
```
| Field | When |
|---|---|
| `phone`, `otp` | Always |
| `role` | `"CLIENT"` or `"STAFF"`. **Required only for a new number.** |
| `full_name` | Optional, new number only. If the user typed a name, send it. |
| `series` | Optional, new staff only (`UC`, `SC`, `CK`). Don't add a picker for it. The RM sets it on the call. |

Response: the **same shape as `POST /auth/login` today**, plus `is_new_user`:
```json
{ "access_token": "…", "refresh_token": "…",
  "must_change_password": false,
  "is_new_user": true,
  "user": { "id": "…", "full_name": "", "role": "STAFF", "phone": "9876543210", "is_active": true, "branch_id": null,
            "staffCode": "new004", "pipelineStage": "S1_INTAKE", "series": null,
            "profile_complete": false,
            "profile_missing": ["full_name", "date_of_birth", "address", "series"] } }
```
For a client, `user` has `customerCode`, `customerName` (`null` until they give a name), `profile_complete`, and `profile_missing` (`["name","address"]` for a new one).

Errors:
| Status | `message.message` | What the app does |
|---|---|---|
| 401 | `Incorrect OTP.` | Shake the field, let them retry. After 5 wrong tries the code is cancelled; they must resend. |
| 400 | `This OTP has expired — request a new one.` | Enable "Resend". |
| 400 | `This number is not registered yet — send role: CLIENT or STAFF to sign up.` | You forgot `role` for a new number. Ask, then call verify again **with the same code** (it stays valid). |
| 403 | `This number belongs to an office account — sign in with your password.` | Show the §1 message. |
| 403 | `This number cannot be registered. Please contact HomeGenny.` | Restricted list. Show as is. |

**Notes**
- `must_change_password` is always `false` for these accounts. Never send an OTP user to Change Password.
- `user.full_name` can be **empty** (`""`). Wherever the app shows a name (header, greeting, drawer), fall back to
  the phone number or "Welcome".
- Refresh token, logout, and biometric unlock work as they do today. Nothing changes after the tokens are saved.

## 3. What to remove or change

**Register screen.** Remove every field: name, email, password, PAN, address, city, state, pincode, alternate
number, DOB, gender, category. The simplest option: route `/register` to the login screen (keep `?role=staff|client`
to pre-select the "Client or Staff?" answer). The `POST /auth/register/customer` and `/auth/register/staff`
endpoints still work for old app versions, but the new app should not call them.

**Login screen.**
- Remove the password field.
- Remove "Forgot password?". App users have no password.
- Keep the "Register" link, but it now does the same thing as Continue.

**OTP screen.** Today it runs after a password login and calls `POST /auth/verify-otp` (`ApiConstants.authVerifyOtp`).
That endpoint is only for **password reset**; it does not sign anyone in. Point the OTP screen at
`POST /auth/otp/verify`, and make it the step that saves the tokens. Remove the hard-coded
`'+1 (555) 019-2834'` placeholder phone.

**Change Password screen.** It is no longer reachable for app users (see `must_change_password` above). Leave it
in the code for now.

## 4. After sign-in — routing

Route by `user.role` as today (`CLIENT` → client dashboard, `STAFF` → staff home). Then read
`user.profile_complete`:

| Role | `profile_complete: false` means | What the app does |
|---|---|---|
| STAFF | S1 is not done. The RM still has to call and fill in name / DOB / address / category. | §5 |
| CLIENT | Name or address is missing. | Nothing at sign-in. They use the app normally; the gap is filled on the first staff request (§6). |

`GET /user/profile` (already called after login) carries the same two fields, so refreshing it updates the state.

## 5. Staff — "Profile under review"

A new staff member sits at **Stage 1 – Intake** until an RM completes it. At that point:
- `pipelineStage` = `S1_INTAKE`, `series` = `null`, `full_name` = `""` (unless they typed one).
- `GET /staff/dashboard` and `GET /staff/pipeline` work and return empty or Stage 1 data. Other staff screens
  have nothing to show yet, so hide them (below).

**Show on the staff home, while `profile_complete` is false:**
> **Thanks for signing up!**
> Your HomeGenny Relationship Manager will call you on **98765 43210** to complete your profile.
> Keep your phone reachable.

- Hide or disable whatever needs a profile: duty, check-in, training, documents, and agreements.
- Show the existing pipeline timeline (`GET /staff/pipeline`); it shows Stage 1 as current.
- **Staff profile screen:** show the phone. For each missing field show "RM will fill this in". Don't add an edit form for S1 fields.
- **When does it change?** Once the RM presses "Complete S1", the staff moves to Stage 2 and `profile_complete`
  becomes `true`. Re-read `GET /user/profile` on app resume and on pull-to-refresh. A push notification isn't needed for now.
- `series` being `null` must not crash anything. Anywhere you map series → label/colour, handle null ("—").

## 6. Client — name on the first staff request

A new client has `profile_missing: ["name", "address"]`. `GET /client/profile` returns `name: null`, `address: null`.
They can use every client screen. The gap is filled when they request staff.

**Request Staff form (`client_staff_request_form.dart`):**
- At app start (or when the form opens) read `GET /client/profile`.
- If `profile_missing` contains `name`: add a required **"Your name"** field on the **Address** step (above the
  address). Prefill nothing.
- The address step is already there and required. If the client has no saved address, the address typed here
  becomes their home address automatically.
- Send the name inside a **`profile`** block in the same request:

```json
POST /client/staff-requests
{ "series": "UC", "start_date": "2026-10-24", "start_time": "08:00",
  "address": "22 Green Park, New Delhi", "lat": 28.5592, "lng": 77.2066,
  "requirements": { "patient_age": 80, "mobility": "ASSISTED" },
  "profile": { "full_name": "Meera Kapoor", "city": "New Delhi", "pincode": "110016" } }
```

| `profile` field | Notes |
|---|---|
| `full_name` | **Required while `name` is missing.** 2+ characters. |
| `city`, `state`, `pincode` | Optional. Pincode is 6 digits. Send them if the address step has them. |
| `address` | Optional. If left out, the request's `address` is used as the home address. |

- The profile is saved **only if the request itself is valid**. A request that fails validation saves nothing.
- Without the name you get **400** with `message.error = "PROFILE_INCOMPLETE"` and `message.profile_missing`.
  Show the name field and resend.
- Once filled, `profile_complete` is `true` and later requests don't need the `profile` block. Sending it anyway is harmless.

## 7. Client profile screens — make them save

`ClientPersonalDetailsScreen` and `ClientAddressScreen` already exist, but `updateProfile` goes to the dummy API.
Wire it to the real endpoint:

**`PATCH /client/profile`** (CLIENT only). Every field is optional; only fields you send change. Response = same as `GET /client/profile`.
```json
{ "full_name": "Meera Kapoor", "email": "meera@example.com",
  "address": "22 Green Park, New Delhi", "city": "New Delhi", "state": "Delhi", "pincode": "110016",
  "lat": 28.5592, "lng": 77.2066 }
```
- `name` is accepted as an alias of `full_name` (what the screen sends today).
- **Phone can't be changed here** (it is the login). Make the phone field read-only and don't send it.
- Validation errors (400): pincode not 6 digits, invalid email, email used by another account, name < 2 characters, address < 5 characters.
- `pan_card` and `gstn` are accepted too, but **don't add them to the app**. The RM or Finance collects them.

**`GET /client/profile`** now also returns:
```json
{ "name": null, "email": null, "phone": "9876543210", "address": null, "city": null, "state": null, "pincode": null,
  "lat": null, "lng": null, "pan_card": null, "gstn": null,
  "self_registered": true, "profile_complete": false, "profile_missing": ["name", "address"],
  "payment_method": null, "account_last4": null, "upi_id": null }
```
`name` is `null` until the client gives one. Show "Add your name" instead of a blank.

## 8. Old app versions in users' hands

They keep working:
- Password login works for anyone who has a password.
- The full register payloads are still accepted. A staff member registered this way now **stays at Stage 1**
  until the RM confirms it. Before this change they went straight to Stage 2.

## 9. Test checklist (local or dev server)

1. New number → Continue → "Client or Staff?" → Staff → OTP `123456` → lands on staff home with "Profile under review".
2. Same number again → no role question → straight in.
3. RM web → **Leads → Staff** → "Complete S1" for that number → app pull-to-refresh → normal staff home, Stage 2.
4. New number → Client → dashboard works → Request Staff → "Your name" shows on the Address step → submit →
   Profile shows the name and address.
5. Second request → no name field.
6. Personal details / Address screens save and the values persist after app restart.
7. Wrong OTP → error. Wait 10 min (or resend) → old code refused.
8. An RM's number (e.g. `9800000002`) → "office account" message.
9. Names: no blank headers anywhere for a user with no name (phone or "Welcome" instead).

## 10. For reference — what the RM sees (web, already built)

- **Leads → Staff:** app sign-ups with an "S1 pending" badge and what's missing. **Complete S1** opens the intake
  form prefilled with the phone (name, DOB, address, category, gender, Aadhaar optional, language tier, etc.).
  Saving moves the staff to S2 and claims them for that RM.
- **Leads → Clients:** app sign-ups with profile status and request count. The RM can fill name, address, PAN and
  GST on a call, and leave a call note.
- The pipeline won't move anyone S1 → S2 until name, DOB, address and category are filled in.

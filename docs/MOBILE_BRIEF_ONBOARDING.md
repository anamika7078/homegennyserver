# Mobile App Brief — Login, Then "Complete Your Profile"

**21 Oct 2026 · For the Flutter app (checked against `homegennyapp` main @ `fc9f9d3`).**

This replaces §5–§7 of *Sign-in and Sign-up with a Mobile Number Only* (`MOBILE_BRIEF_MOBILE_ONLY_REGISTRATION.md`).
The OTP login from that brief (§1–§4: `POST /auth/otp/send`, `POST /auth/otp/verify`) stays exactly as it is.

**The new flow**
1. Login with mobile + OTP (code is `123456` for now).
2. Inside the app, the user has to **complete their profile**.
   - **Staff:** submitting the profile finishes Stage 1. Verification (Stage 2) starts, and an RM is assigned automatically.
   - **Client:** the profile unlocks "Request staff".
3. Until the profile is complete, the **home is visible but every action is locked**. The server refuses actions
   too (see §1), so it is not only the app's job.

The backend is built and tested against live API calls (`npm run test:onboarding`, 39 checks).

**Common rules (same as the other briefs)**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>", … } }`. Show `message.message` as it is.
- All app text is English.

## What changes, and on which screen

| What changes | App screen | Section |
|---|---|---|
| After login, ask `GET /me/onboarding` what to show | Splash / after OTP | §1 |
| **403 `PROFILE_INCOMPLETE`** on any action → open the profile wizard | Everywhere | §1 |
| City is a **dropdown** from `GET /meta/cities` | Both wizards | §2 |
| **Staff profile wizard**, 3 steps + Submit | Staff | §3 |
| After Submit: "Your RM will call you" / "We'll assign an RM soon" | Staff home | §3.4 |
| Name, DOB, gender, category **locked** after Submit | Staff profile | §3.5 |
| Staff home: **real RM, real tasks**. No demo data any more. | Staff home | §4 |
| **Client profile wizard**, then Request Staff | Client | §5 |
| Remove the "Your name" field from Request Staff | Client: Request Staff | §5 |

---

## 1. `GET /me/onboarding` (CLIENT, STAFF): what to show

Call it right after login, on app start, and after a profile save or submit.

```json
{ "role": "STAFF",
  "profile_complete": false,
  "missing": ["full_name", "date_of_birth", "gender", "series", "address", "city", "pincode", "emergency_contact"],
  "next_step": "COMPLETE_PROFILE",
  "pipeline_stage": "S1_INTAKE",
  "rm": null }
```

| `next_step` | Who | Show |
|---|---|---|
| `COMPLETE_PROFILE` | both | The profile wizard. The home stays reachable, but action buttons say "Complete your profile first". |
| `WAIT_FOR_RM` | staff | Home with a card: "Profile submitted. We'll assign your RM soon." |
| `VERIFICATION` | staff | Home with a card: "Your RM `rm.name` (`rm.phone`) will call you to verify your documents." |
| `READY` | both | Normal app |

`profile_complete` and `profile_missing` are also on the login response (`user.profile_complete`, `user.profile_missing`)
and on `GET /user/profile`, so routing right after login needs no extra call.

**The gate.** While `profile_complete` is false, every **GET works** (screens load, mostly empty). Every **POST/PUT/PATCH
is refused**, except the profile routes, logout/refresh and marking notifications read:
```json
{ "statusCode": 403, "message": { "statusCode": 403, "error": "PROFILE_INCOMPLETE",
  "message": "Complete your profile first — date_of_birth, city missing.", "missing": ["date_of_birth", "city"] } }
```
On `message.error == "PROFILE_INCOMPLETE"` anywhere → open the wizard on the first missing step.

## 2. `GET /meta/cities` (public): the city dropdown

```json
{ "cities": [
  { "city": "Delhi NCR", "areas": ["Gurgaon", "Noida", "South Delhi"] },
  { "city": "Pune", "areas": ["Baner", "Karver Nagar", "Moshi"] },
  { "city": "Mumbai", "areas": ["Andheri", "Bandra"] },
  { "city": "Other", "areas": [] } ] }
```
- City is a **dropdown**, not free text. It decides the branch and the RM.
- Area is an optional second dropdown, shown when the city has areas.
- "Other" is allowed. The user is still registered, but no RM is assigned automatically.

## 3. Staff profile

### 3.1 `GET /staff/profile`
Returns real values only. **A blank is `null`**: no more "Pooja Mishra", "Maid", "STF-1029" or "S2_VERIFY" for a new user.
```json
{ "id": "…", "staffApplicantId": "…", "staffCode": "new004", "fullName": null, "mobile": "9876543210", "email": null,
  "series": null, "pipelineStage": "S1_INTAKE", "address": null, "dateOfBirth": null, "gender": null,
  "city": null, "area": null, "pincode": null, "emergencyContactName": null, "emergencyContactMobile": null,
  "languages": [], "alternatePhone": null, "experienceYears": null,
  "profile_complete": false, "missing": ["full_name", "…"], "locked_fields": [] }
```
`dateOfBirth` is `YYYY-MM-DD`. Show "Not added" for nulls.

### 3.2 The wizard (3 steps + review)

| Step | Fields | Rules (the server checks the same) |
|---|---|---|
| **1. About you** | Full name · Date of birth · Gender · Work category | name 2–200 chars · age **18–65** · gender MALE/FEMALE/OTHER · category UC/SC/CK (labels from `GET /meta/series`) |
| **2. Where you live** | City (dropdown) · Area (optional) · Address · Pincode | pincode 6 digits, not starting with 0 · address 5+ chars |
| **3. Emergency contact** | Name · Mobile · Languages (multi-select, optional) · Experience in years (optional) | 10-digit mobile, **not your own number** |
| **Review** | Everything, with "Edit" per step | then **Submit** |

No photo for now.

### 3.3 Saving and submitting
- **Each step's Next** → `PUT /staff/profile` with that step's fields (any subset). The response is the same as GET.
  A 400 is a field error: show `message.message` under the form.
- **Submit** → `POST /staff/profile/submit`. Send the whole form again; the server saves it, then checks that
  everything required is filled.

```json
POST /staff/profile/submit
{ "full_name": "Geeta Kumari", "date_of_birth": "1990-06-15", "gender": "FEMALE", "series": "UC",
  "address": "12 Malviya Nagar", "city": "Delhi NCR", "area": "South Delhi", "pincode": "110017",
  "emergency_contact_name": "Mohan", "emergency_contact_mobile": "9811122233", "languages": ["Hindi", "English"] }
```
Response (201):
```json
{ "outcome": "ADVANCE_S2",
  "assigned": { "id": "…", "name": "Pooja Mishra" },
  "role": "STAFF", "profile_complete": true, "missing": [], "next_step": "VERIFICATION",
  "pipeline_stage": "S2_VERIFY", "rm": { "name": "Pooja Mishra", "phone": "9800000002" } }
```
- `assigned: null` + `next_step: "WAIT_FOR_RM"` → no RM in that city yet. That's fine; the office assigns one.
- `outcome: "RESTRICTED"` → show `message` ("We could not complete your registration. Please contact HomeGenny.")
  and nothing else. The account can't go further.
- 400 with `message.error == "PROFILE_INCOMPLETE"` and `message.missing` → jump to the step with the first missing field.

### 3.4 After Submit
Show a success screen: "You're in! Your RM **{rm.name}** will call you on {mobile} to verify your documents."
For `WAIT_FOR_RM`: "Profile submitted. We'll assign your RM soon." Then go to the staff home.

### 3.5 Editing later
After Submit, `locked_fields` = `["full_name", "date_of_birth", "gender", "series"]`. Show a lock icon and
"Ask your RM to change this"; `PUT` refuses them with a 400. Address, area, city, pincode, emergency contact,
languages, email, alternate phone and experience stay editable with `PUT /staff/profile`.

## 4. Staff home: real data only
`GET /staff/dashboard`:
```json
{ "staffCode": "geeta001", "fullName": "Geeta Kumari", "series": "UNSKILLED_CARE", "pipelineStage": "S2_VERIFY",
  "completionPct": 17, "profileComplete": true,
  "assignedRm": { "name": "Pooja Mishra", "phone": "9800000002" },
  "todayTasks": [ { "id": "AADHAAR_EKYC", "title": "Verify your Aadhaar", "done": false },
                  { "id": "POLICE_VERIFICATION", "title": "Police verification", "done": false } ] }
```
- `assignedRm` is `null` until an RM is assigned. Show "RM not assigned yet", never a made-up name.
- `todayTasks` comes from the pipeline. A new user gets `[{ "id": "profile", "title": "Complete your profile" }]`
  (tap → wizard). It can be `[]`.
- The login response's `staffCode`, `series`, `pipelineStage` and `assignedRm` follow the same rule: real or `null`.

## 5. Client profile

**Wizard (2 steps):** 1. Your name → 2. Your home: City (dropdown) · Address · Pincode · map pin. Email is optional.
Don't ask for PAN or GST; the RM or Finance collects them.

Save with the existing `PATCH /client/profile` (wire it to the real API; it is dummy today):
```json
{ "full_name": "Anil Arora", "address": "5 Hauz Khas", "city": "Delhi NCR", "pincode": "110016",
  "lat": 28.5494, "lng": 77.2001, "email": "anil@example.com" }
```
- `name` is accepted as an alias of `full_name`.
- City must come from `GET /meta/cities` (400 otherwise).
- The response is `GET /client/profile` with `profile_complete` and `profile_missing` (`name`, `address`, `city`, `pincode`).

**Request Staff:** only enabled when the profile is complete. The server refuses earlier requests with **403
`PROFILE_INCOMPLETE`**. **Remove the "Your name" field and the `profile` block** described in the earlier brief;
the server no longer reads them. The request's own address can still be different from the home address.

## 6. Test checklist (dev server)
1. New staff number → OTP → wizard opens. Home is reachable, but check-in, training etc. say "Complete your profile first".
2. Profile screen shows "Not added" everywhere. **No "Pooja Mishra", no "Maid".**
3. Enter DOB making you 16 → error. Your own number as emergency contact → error.
4. City "Delhi NCR" → Submit → success screen with the RM's name; home shows the RM and "Verify your Aadhaar".
5. City "Pune" → Submit → "We'll assign your RM soon".
6. After Submit: name is locked, address can be edited.
7. New client → wizard → Request Staff is disabled until it's saved; afterwards a request goes through.
8. Logout/login: no wizard any more for completed users.

# Mobile App Brief — Series, Staff Requests, Care & Cook Tracking

**This is the one document the mobile team needs for this work.** Every section below is built on the
backend and tested against live API calls, so all six are ready to build.

| # | Section | Status |
|---|---|---|
| 1 | Series: UC / SC / Cook only, Stage 2.5 off | ✅ Ready |
| 2 | Staff Request: client app + RM | ✅ Ready |
| 3 | Nurse / Caretaker: care plan + daily checklist | ✅ Ready |
| 4 | Cook: food profile + menu + meal log | ✅ Ready |
| 5 | Client instructions (text / voice note) | ✅ Ready |
| 6 | Staff sees every client input ("New from the family", "Mark as read") | ✅ Ready |

**Common rules (all sections)**
- **All app text is English.** Button labels, banners and messages in this brief are the exact English text to show. The API returns English messages only.
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>", "error": "Bad Request" } }`. Show `message.message` to the user as it is.
- Series has two forms. **Long** `UNSKILLED_CARE / SKILLED_CARE / COOK / MAID / DRIVER` is in `series_db`. **Short** `UC / SC / CK / MAID / DR` is in `series`. Never compare one form against the other.

---

## 1. Series: UC / SC / Cook only, Stage 2.5 off

### In short

- HomeGenny now takes on only three series: **Unskilled Caretaker (UC), Skilled
  Caretaker (SC), and Cook (CK, new)**.
- **Maid and Driver are paused, not deleted.** Staff who already have those
  series keep working everywhere (profile, attendance, payslip, placement).
  The backend refuses only *new* Maid/Driver staff.
- **Stage 2.5 (Driver practical test) is switched off.** S2 goes straight to S3.
- **Do not hardcode the series list any more.** Read it from the new
  `GET /meta/series`, so the next change needs no app release.

---

### 1.1 New endpoint: `GET /api/v1/meta/series`

**Public** (no token), because self-registration needs it before login.

```json
{
  "success": true,
  "data": {
    "series": [
      { "value": "UNSKILLED_CARE", "short": "UC",   "label": "Unskilled Caretaker", "active": true  },
      { "value": "SKILLED_CARE",   "short": "SC",   "label": "Skilled Caretaker",   "active": true  },
      { "value": "COOK",           "short": "CK",   "label": "Cook",                "active": true  },
      { "value": "MAID",           "short": "MAID", "label": "Maid",                "active": false },
      { "value": "DRIVER",         "short": "DR",   "label": "Driver",              "active": false }
    ],
    "stage_2_5_enabled": false
  }
}
```

| Field | Meaning |
|---|---|
| `value` | The DB enum. This is what `series_db` holds on every staff object. |
| `short` | The display code. This is what `series` holds on staff objects, and what `POST /rm/intake` and `POST /auth/register/staff` take. |
| `active` | `true` = can be chosen for a **new** staff member. |
| `stage_2_5_enabled` | `false` = hide everything about Stage 2.5 (see 1.4). |

> ⚠️ **Series has two forms, long and short.** Mixing them up has caused 3 silent bugs
> before. **Long:** `UNSKILLED_CARE / SKILLED_CARE / COOK / MAID / DRIVER`.
> **Short:** `UC / SC / CK / MAID / DR`. Note that COOK's short code is **`CK`**,
> not `COOK`. The backend accepts either form on input, but an unknown value is
> now a **400**. (It used to be silently treated as SKILLED_CARE.)

Cache the response for the session. If the call fails, fall back to
UC / SC / CK as active.

---

### 1.2 Where series is **chosen** → show only `active: true`

| Screen | File (origin/main) | Change |
|---|---|---|
| RM staff intake | `rm/presentation/screens/rm_staff_intake_screen.dart` | Series picker from `/meta/series` where `active`. Remove the DR and MAID options. |
| Staff self-registration | `auth/...` (register screen) | Same. |
| `StaffSeries` model | `rm/domain/models/pipeline_stage.dart` | Add `cook = 'CK'`. Label `'Cook (CK)'`. Deposit **₹1000**. `all` must no longer drive pickers. |

New-staff calls that send a paused series now get:
```
400 { "message": "Maid series is not being taken on right now. Allowed: Unskilled Caretaker, Skilled Caretaker, Cook." }
```
A missing series → `400 "series is required (UC, SC or CK)."`
An unknown series → `400 "Unknown series \"X\". Use one of: UC, SC, CK (or MAID, DR for existing staff)."`
Show `message` as it is.

### 1.3 Where series is **shown or filtered** → handle all five

Lists, badges and filters must still handle MAID and DR, because those staff
still exist. Add **CK** everywhere a series badge or colour is looked up, and
make sure an unknown value doesn't crash or show as "DR":
- Kanban series filter: list all five, and mark paused ones (e.g. "MAID (paused)").
- Staff cards, staff detail, placement cards, client app's staff profile: add a CK badge.
- `GET /video-cert/prompts/CK` returns **9 prompts** for Cook (the same count as MAID).

### 1.4 Stage 2.5 → hide it

When `stage_2_5_enabled === false`:

| Where | Change |
|---|---|
| `PipelineStages.order` / `canAdvance` | Drop `S2_5_ASSESS` from the forward flow. **S2 → S3** is the normal next step. |
| RM dashboard stage chips (`rm_dashboard_screen.dart`) | No S2.5 chip, unless the API sends staff in it. |
| RM staff detail "Assessment · S2.5" tile (`rm_staff_detail_screen.dart`) | Hide. |
| `rm_assessment_screen.dart` (Driver practical) | Unreachable from navigation. |
| Hold / Complete stage picker | Don't offer S2_5_ASSESS. |

Backend behaviour (live):
- `POST /rm/pipeline/:id/advance` with `to_stage: "S2_5_ASSESS"` →
  `400 "Stage 2.5 (practical assessment) is switched off while the Driver series is paused — move S2_VERIFY → S3_TRAIN instead."`
- Hold/Complete on `S2_5_ASSESS` for a staff not in it → 400.
- **A staff already sitting in S2_5_ASSESS can still be moved out** (→ S3_TRAIN /
  DEFERRED / TERMINAL). So don't hide such a staff member: if the API returns a
  staff whose `pipeline_stage` is `S2_5_ASSESS`, show them with the S2.5 label.
- **A staff deferred *from* S2_5_ASSESS resumes back into it.** `POST /rm/deferred/:id/resume`
  with no `to_stage` still lands on S2_5_ASSESS. This is allowed because a resume can't go past
  the stage the staff was deferred from. Anyone deferred from another stage can't enter S2_5.
- `GET /rm/kanban` → `columns` **has no `S2_5_ASSESS` key** unless someone is in it.
  Build columns from the keys the API returns, not from a fixed list.
- Staff app `GET /staff/pipeline` (progress timeline): already returns **5 stages**
  (no S2.5) for staff who never went through it. Render what comes back.
  `completion_pct` is computed over those 5.

### 1.5 Checklist (section 1)

- [ ] `GET /meta/series` wired in, cached, with a fallback
- [ ] Intake + self-registration pickers: active series only (UC/SC/CK)
- [ ] `StaffSeries.cook = 'CK'`, label, deposit ₹1000, badge colour
- [ ] Every series badge/colour map handles CK, and doesn't default unknown values to DR
- [ ] Kanban filter shows all five series; paused ones marked
- [ ] S2.5 removed from forward flow, chips, staff-detail tile, hold picker
- [ ] A staff already in S2_5_ASSESS still shows and can be moved out
- [ ] Kanban columns come from API keys

---

## 2. Staff Request: client app + RM

### In short
The client asks for staff from the app. The request goes to an RM automatically. The RM puts forward
(shortlists) a few staff, the client chooses one, and the RM makes the trial placement. The RM can also
raise a request on a client's behalf, including for a new lead who has no account yet (that part is web only).

```
Client: Request Staff ──▶ ASSIGNED (RM notified)
                             │  RM shortlists
                             ▼
                        SHORTLISTED ──(client: "none of these")──▶ back to ASSIGNED
                             │  client chooses
                             ▼
                      CLIENT_SELECTED ──(RM makes the trial placement)──▶ FULFILLED
Any open status ──(client or RM cancels, with a reason)──▶ CANCELLED
```

| `status` | Show the client |
|---|---|
| `NEW` | "Request received — assigning your relationship manager" |
| `ASSIGNED` | "Your RM is finding staff for you" |
| `SHORTLISTED` | "Staff ready for you to choose" → open the shortlist |
| `CLIENT_SELECTED` | "You chose — your RM is setting up the trial" |
| `FULFILLED` | "Staff placed" |
| `CANCELLED` | "Cancelled" + `cancel_reason` |

### Screens to build (client app)
1. **Request Staff form**: a new button on the client home screen.
2. **My Requests list**: status chip, plus "N staff to choose from" when `shortlisted > 0`.
3. **Request detail**: what was asked for, the RM's name and phone, and the shortlist cards with
   **Choose** and **None of these** buttons. Add a **Cancel request** action while the request is open.

### Request Staff form
- Series picker: only `active: true` from `GET /meta/series` (UC / SC / CK).
- The fields below the picker change with the series:

| Field | Applies to | Values |
|---|---|---|
| `series` * | all | `UC` / `SC` / `CK` |
| `placement_type` | all | `PERMANENT` (default) / `TEMPORARY` (hourly) |
| `shift_hours` | all | number, default 8 |
| `start_date` | all | `YYYY-MM-DD`, not in the past |
| `address` | all | defaults to the client's address if left out |
| `language`, `notes` | all | text |
| `gender_pref` | all | `ANY` (default) / `FEMALE` / `MALE` |
| `budget_min`, `budget_max` | all | ₹/month |
| `headcount` | all | 1–20, default 1 |
| `requirements.patient_age` * | UC, SC | number |
| `requirements.mobility` * | UC, SC | `WALKING` / `ASSISTED` / `BEDRIDDEN` |
| `requirements.patient_gender` | UC, SC | `FEMALE` / `MALE` |
| `requirements.conditions` | UC, SC | string[] (e.g. `["diabetes"]`) |
| `requirements.medical_needs` | **SC only** | any of `MEDICATION`, `VITALS`, `WOUND_CARE`, `INJECTION`, `CLINICAL_ESCALATION` |
| `requirements.night_care` | UC, SC | boolean |
| `requirements.diet_type` * | CK | `VEG` / `EGG` / `NON_VEG` / `JAIN` / `VEGAN` |
| `requirements.family_size` * | CK | number |
| `requirements.meals_per_day` * | CK | any of `BREAKFAST`, `LUNCH`, `SNACKS`, `DINNER` |
| `requirements.cuisines`, `requirements.health_conditions` | CK | string[] |

\* = required. Hide medical duties when UC is picked: the backend refuses them for UC and says to ask for SC.

### APIs (client token)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/client/staff-requests` | the form above | the request (client view) |
| GET | `/client/staff-requests` | — | `{ items[], total }`. Each item has `shortlisted` and `selected` counts. |
| GET | `/client/staff-requests/:id` | — | the request + `rm` + `candidates[]` |
| POST | `/client/staff-requests/:id/select` | `{ staff_id, note? }` | updated request |
| POST | `/client/staff-requests/:id/reject-shortlist` | `{ reason }` (required) | updated request |
| POST | `/client/staff-requests/:id/cancel` | `{ reason }` (required) | updated request |

**Real response**: `GET /client/staff-requests/:id` with one staff shortlisted (copied from a live call):
```json
{
  "success": true,
  "data": {
    "id": "33d5114c-d135-4a5a-ab70-6d19d3753066",
    "request_no": "SR-2026-0011",
    "status": "SHORTLISTED",
    "source": "CLIENT_APP",
    "series": "UC",
    "series_db": "UNSKILLED_CARE",
    "placement_type": "PERMANENT",
    "shift_hours": 12,
    "start_date": "2026-10-20",
    "address": "1 Test Lane, New Delhi",
    "language": "Hindi",
    "gender_pref": "FEMALE",
    "budget_min": 15000,
    "budget_max": 20000,
    "headcount": 1,
    "requirements": { "mobility": "ASSISTED", "conditions": ["DIABETES"], "night_care": true, "patient_age": 78, "medical_needs": [] },
    "notes": "Father needs help walking",
    "cancel_reason": null,
    "created_at": "2026-10-12T10:29:22.375Z",
    "assigned_at": "2026-10-12T10:29:22.372Z",
    "shortlisted_at": "2026-10-12T10:29:22.457Z",
    "selected_at": null,
    "fulfilled_at": null,
    "cancelled_at": null,
    "rm": { "name": "Ritu Sharma", "phone": "98XXXXXXXX" },
    "candidates": [
      {
        "candidate_id": "9c32d12d-a6b8-4c6c-b9a0-78ed3b3cac18",
        "status": "PROPOSED",
        "rm_note": "Experienced with elderly, speaks Hindi",
        "client_note": null,
        "staff": {
          "id": "f818b116-6b6f-4f6a-8b6c-35d0a4e44230",
          "first_name": "Sunita",
          "series": "UC",
          "series_db": "UNSKILLED_CARE",
          "language_tier": "T2",
          "gender": "FEMALE",
          "experience_years": 4,
          "aadhaar_verified": false,
          "police_verified": false
        }
      }
    ]
  }
}
```
- Send **`staff.id`** (not `candidate_id`) as `staff_id` when choosing.
- Candidate `status`: `PROPOSED` (show Choose), `CLIENT_SELECTED` ("You chose"), `PLACED`, `CLIENT_REJECTED`.
  `WITHDRAWN` candidates are never sent to the client.
- The card deliberately has **no phone, surname, Aadhaar or address**. Don't try to show them.
  `gender` and `experience_years` can be `null`.
- Show **Choose** and **None of these** only while `status === "SHORTLISTED"`.
- The `POST` and `GET` list responses have the same fields as this detail response.
  The list adds `shortlisted` and `selected` counts instead of `candidates`.

**Errors** (show `message.message` as it is):
```json
{ "statusCode": 400, "message": { "message": "An Unskilled Caretaker cannot do medical duties (INJECTION). Ask for a Skilled Caretaker (SC) instead.", "error": "Bad Request", "statusCode": 400 } }
```
Others you will see:
- "Maid series is not being taken on right now…"
- "requirements.mobility is required — one of WALKING, ASSISTED, BEDRIDDEN."
- "start_date cannot be in the past."
- "Only a shortlisted (PROPOSED) staff member can be chosen."
- "This request is FULFILLED — nothing more can change on it."
- "No client account is linked to this login." (a CLIENT login that has no client account behind it)

### Notifications
In-app rows on the existing `GET /client/notifications` (title + body). **Push (FCM) is not wired yet**,
because the backend stores no device tokens. Refresh the request screens when the app opens.

| Who | When | `title` |
|---|---|---|
| Client | shortlist ready | "Staff shortlisted for you" |
| Client | request fulfilled | "Your staff is on the way" |
| Client | HomeGenny closed it | "Staff request closed" |
| RM | new request / assigned to them | "New staff request" / "Staff request assigned to you" |
| RM | client chose / turned the shortlist down / cancelled | "Client chose staff" / "Client turned down the shortlist" / "Client cancelled a request" |
| BM (or Admin) | no RM in the branch / 24h with no shortlist | "Staff request needs an RM" / "Staff request waiting over 24h" |

### RM app (optional; the web already has all of this at `/rm/requests`)
If the RM app gets a Requests tab, these are the calls (RM token). Each one returns the full RM view,
which includes `candidates[].staff.mobile`. **Never** use these endpoints from the client app.

| Method | Path | Body |
|---|---|---|
| GET | `/rm/staff-requests?open=true` (or `?status=NEW,ASSIGNED`) | — returns `items[]` with `sla_breached`, `client_name`, `candidate_counts` |
| GET | `/rm/staff-requests/:id` | — |
| GET | `/rm/staff-requests/:id/candidates` | — returns `items[]: { staff, ready, score, reasons[], on_this_request }` |
| POST | `/rm/staff-requests/:id/shortlist` | `{ staff_ids[], rm_note? }` |
| DELETE | `/rm/staff-requests/:id/shortlist/:staffId` | — |
| POST | `/rm/staff-requests/:id/select` | `{ staff_id }`, choose on the client's behalf |
| POST | `/rm/staff-requests/:id/cancel` | `{ reason }` |
| POST | `/placements` | the usual body **+ `staff_request_id`**. `placement_type`/`shift_hours` default from the request. |

`POST /placements` with `staff_request_id` refuses a staff member who isn't on that request's
shortlist, a different client, a different series, or a lead with no client account.

---

## Before sections 3–6: placements, files, dates

**Everything in 3–6 is per placement.** The client app gets `placementId` and `features` on each item of
`GET /client/assigned-staff` (new fields, existing ones unchanged):
```json
{ "placementId": "2c3a…", "features": { "care_plan": true, "menu": false, "instructions": true },
  "staffId": "…", "fullName": "Kavita Nurse", "series": "SKILLED_CARE", "status": "ACTIVE_DEPLOYED", … }
```
Show the **Care plan** screens when `features.care_plan` is true (UC/SC staff), and **Menu** when
`features.menu` is true (Cook). **Instructions** are available for every staff member.

The staff app finds its placements through `GET /staff/care/today` (caretaker) or
`GET /staff/care/cook/today` (cook). Both return one entry per active placement.

**Who can call what.** Shared reads live under `/care/placements/:pid/…` and work for the client, the staff
member and the RM. The backend decides per call:
- **Client:** always reads; writes only while the placement is active.
- **Staff:** reads and writes only while working there. After the placement ends, they get **404**.
- **Another client:** gets **404**.

**Files (photos, prescriptions, voice notes): upload first, then send the id.**

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/care-files` | multipart: `placement_id`, `kind`, `file` | `{ id, kind, mime_type, size, name, url }` |
| GET | `/care-files/:id` | — | the file (stream). Send the Bearer token: there are no public links. |

| `kind` | Who | Types | Max |
|---|---|---|---|
| `PHOTO` | client, staff | jpg, png, webp | 5 MB |
| `PRESCRIPTION` | client only | jpg, png, webp, pdf | 10 MB |
| `VOICE` | client, staff | mp3, m4a, aac, ogg, webm, wav | 5 MB |

A file id only works on the placement it was uploaded to; sending it on another one is a 400.

**Dates and times are IST.** Use `YYYY-MM-DD` and `HH:MM` (24-hour). Staff can fill only **today or
yesterday**. Older days are closed (400).

---

## 3. Nurse / Caretaker: care plan + daily checklist

```
Client writes care plan ──▶ staff notified ("Care plan changed — please read") ──▶ staff taps "Mark as read" (section 6)
        │
        ▼ every day (from the active plan)
Checklist: each medicine dose, each check (BP, sugar…), each activity at its time
        │  staff ticks DONE (vitals: with a reading) or SKIPPED (with a reason)
        ▼
  • Reading outside the range → client + RM alerted at once (far outside → BM too)
  • Dose not ticked 1 hour after its time → MISSED → client + RM told (once)
Staff fills the end-of-day report (meals, water, sleep, mood, notes, photos)
Client sees it all: today, history, monthly PDF
```

### Client app screens
1. **Care plan editor**: patient details, medicines, checks, activities, diet, dos and don'ts.
   - Editing saves a **new version**. The screen shows "Read by Kavita ✓" or "Not read yet" from
     `staff_acknowledged_at`.
   - Prescription photo: upload as `PRESCRIPTION` first, then put the id in the medicine.
2. **Today**: the checklist with ✓ / missed / skipped, the readings in red or green, and the caretaker's report.
3. **History**: adherence % per day, a readings chart, and a **Download monthly report** (PDF) button.

### Staff app screens
1. **Today**: the list sorted by time.
   - Big buttons: **Done** / **Skip**. Vitals open a number pad (BP has two numbers).
   - Pending items turn red once they are MISSED; they can still be marked Done (stored as late).
2. **Care plan (read-only)**: shows a banner until it is acknowledged (section 6).
3. **Daily report form**.

### APIs

| Who | Method | Path | Body / query |
|---|---|---|---|
| all | GET | `/care/placements/:pid/plan` | — returns `{ plan, staff_acknowledged_at, versions[], vital_types[] }` |
| client | PUT | `/care/placements/:pid/plan` | the whole plan (below); always a new version |
| all | GET | `/care/placements/:pid/day?date=` | default today. Returns `{ summary, tasks[], report }` |
| all | GET | `/care/placements/:pid/history?from=&to=` | default the last 7 days, max 92. Returns `{ medication_adherence_pct, missed_doses, days[], vitals[] }` |
| client/RM | GET | `/care/placements/:pid/report?month=YYYY-MM` | **PDF** (`application/pdf`) |
| staff | GET | `/staff/care/today` | — returns `{ date, placements: [{ placement_id, client, plan: { version, acknowledged, changes }, summary, tasks[], report }] }` |
| staff | POST | `/staff/care/tasks/:id/done` | `{ value?, notes?, photo_file_ids?[] }` |
| staff | POST | `/staff/care/tasks/:id/skip` | `{ reason }` (required) |
| staff | PUT | `/staff/care/daily-report` | `{ placement_id, date?, meals[{meal, description, quantity}], fluid_intake_ml, sleep, mood, hygiene{}, notes, photo_file_ids[] }` |

**Plan body** (`PUT …/plan`):
```json
{
  "patient": { "name": "Ramesh Kumar", "age": 78, "gender": "MALE", "conditions": ["Diabetes"], "allergies": ["Penicillin"],
               "mobility": "ASSISTED", "doctor_name": "Dr Mehta", "doctor_phone": "9811111111",
               "emergency_contact_name": "Amit", "emergency_contact_phone": "9822222222" },
  "medications": [{ "id": "<keep when editing>", "name": "Metformin", "dose": "500", "unit": "mg", "route": "ORAL",
                    "times": ["08:00", "20:00"], "food_relation": "AFTER", "start_date": "2026-10-12", "end_date": null,
                    "instructions": "With water", "prescription_file_id": "<PRESCRIPTION file id>" }],
  "vitals": [{ "type": "BP", "times": ["08:00"] }, { "type": "SUGAR_FASTING", "times": ["07:30"], "min": 70, "max": 130 }],
  "activities": [{ "type": "WALK", "title": "Evening walk", "times": ["17:30"], "duration_min": 20 }],
  "diet_notes": "Low salt", "dos": "Help him stand slowly", "donts": "No sweets"
}
```
- `route`: ORAL, INJECTION, DROPS, INHALER, TOPICAL, OTHER.
- `food_relation`: BEFORE, AFTER, WITH, ANY.
- `activities.type`: EXERCISE, PHYSIO, WALK, BATH, POSITION_CHANGE, OTHER.
- `vitals.type` and default ranges: take them from `vital_types` in `GET …/plan`.
  - The types are BP, SUGAR_FASTING, SUGAR_PP, SUGAR_RANDOM, TEMP (°F), SPO2, PULSE, WEIGHT.
  - BP uses `systolic_min/max` and `diastolic_min/max` (default 90–140 / 60–90). The others use `min`/`max`.
- **When editing, send each item's `id` back.** That keeps today's ticks attached to the same medicine.
  An item without an `id` counts as new.
- **UC placements:** `medications` and `vitals` are refused (400), because an Unskilled Caretaker can't
  do medical duties. Activities and notes are fine. Hide those two parts of the editor for UC.
- The new version's `changes[]` is a list of `{ type, text }`, e.g.
  `"Medicine added: Amlodipine 5 mg at 21:00"` or `"Medicine changed: Metformin 500 mg at 08:00 → … at 08:00, 22:00"`.
  Show `text` as it is.

**Task** (in `tasks[]`):
```json
{ "id": "…", "date": "2026-10-12", "type": "VITAL", "item_id": "…", "title": "Check Blood pressure", "time": "08:00",
  "status": "DONE", "value": { "systolic": 190, "diastolic": 125, "unit": "mmHg" }, "out_of_range": true,
  "skip_reason": null, "notes": "Felt dizzy", "photo_file_ids": [], "done_at": "…",
  "target": { "type": "BP", "unit": "mmHg", "systolic_min": 90, "systolic_max": 140, "diastolic_min": 60, "diastolic_max": 90 } }
```
- `type`: MEDICATION / VITAL / ACTIVITY. `status`: PENDING / DONE / SKIPPED / MISSED.
- Marking a vital done: BP needs `value: { systolic, diastolic }`; other checks need `value: { value }`. Without it you get a 400.
- `target` is there so the app can colour a reading before sending it. For a medicine, `target` has
  `route`, `food_relation`, `instructions` and `prescription_file_id`.

---

## 4. Cook: food profile + menu + meal log

```
Client: food profile (diet, spice, salt/oil, health, allergies) ── belongs to the household, survives a change of cook
Client: weekly menu  ─┐
Cook: suggests menu ──┴▶ client approves / declines (with reason)
Cook: logs each meal (dishes, spice level, optional photo) ──▶ client: "Dinner is ready"
Client: rates the meal (1–5 + tags) ──▶ cook sees it; 7-day average < 3 → RM told
Same complaint 3× in 14 days ──▶ app suggests a profile change (never changed silently)
```

### Client app screens
- **Food profile** form.
- **Week menu**: a Mon–Sun × meal grid. Tap a slot to set the dishes and a note ("less spicy").
  The cook's suggestions show **Approve** / **Decline**. Show `health_warnings` as a yellow note
  (a warning only; it doesn't block).
- **Meals feed**: photos, dishes, and a **Rate** button.
- **Suggestions**: from `feedback_suggestions`, e.g. "Lower spice level from 3 to 2?". A **Yes** button
  re-saves the profile with that one change.

### Staff (cook) app screens
- **Today**: per meal, the menu and the family's note, with the food profile (allergies in red) on top.
  A **Log meal** button (photo optional).
- **Suggest menu**: pick a date and meal, then type the dishes.
- **Ratings**: the family's ratings (they also come through the updates feed in section 6).

### APIs

| Who | Method | Path | Body / query |
|---|---|---|---|
| client | GET | `/client/food-profile` | — returns `{ profile, feedback_suggestions[] }` |
| client | PUT | `/client/food-profile` | `{ diet_type*, allergies[], spice_level 1–5, salt LOW/NORMAL, oil LOW/NORMAL, health_conditions[], cuisines[], dislikes, family_size, notes }` |
| all | GET | `/care/placements/:pid/food-profile` | the cook's (and RM's) way to read it |
| all | GET | `/care/placements/:pid/menu?week=2026-W42` | or any date in the week; default this week. Returns `{ week_start, week_end, items[] }` |
| client | PUT | `/care/placements/:pid/menu` | `{ items: [{ date, meal, dishes: ["Dal", {"name":"Roti","notes":"2 each"}], special_instruction?, servings? }] }`; `dishes: []` clears that slot |
| client | POST | `/client/menu/:id/approve` | — |
| client | POST | `/client/menu/:id/reject` | `{ reason }` (required) |
| cook | POST | `/staff/care/cook/menu-suggestions` | `{ placement_id, items: [{ date, meal, dishes[], notes? }] }`. A slot the family already set → 400. |
| cook | GET | `/staff/care/cook/today` | — returns per placement `{ food_profile, meals: [{ meal, menu, log }], rating }` |
| cook | POST | `/staff/care/cook/meals` | `{ placement_id, date?, meal, dishes: [{ name, spice_level?, photo_file_id? }], servings?, notes? }`. The same meal again replaces it. |
| all | GET | `/care/placements/:pid/meals?from=&to=` | default today. Returns `{ items[], rating: { avg_7d, count_7d, avg_30d, count_30d } }` |
| client | POST | `/client/meals/:id/feedback` | `{ rating 1–5, tags?[], comment? }` |

- `diet_type`: VEG, EGG, NON_VEG, JAIN, VEGAN.
- `meal`: BREAKFAST, LUNCH, SNACKS, DINNER.
- `health_conditions` that trigger menu warnings: DIABETIC, LOW_SODIUM, LOW_FAT, NO_ONION_GARLIC.
  Other values are stored and shown, but trigger no warning.
- Feedback `tags`: PERFECT, TOO_SPICY, LESS_SPICY, TOO_SALTY, LESS_SALT, OILY, UNDERCOOKED,
  OVERCOOKED, COLD, SMALL_PORTION.
- Menu item `status`: PLANNED (client), SUGGESTED (cook), APPROVED, REJECTED. `suggested_by_cook`
  tells them apart; `reject_reason` holds the client's reason. `changes[]` says what the client changed.
- The profile has `version` and `changes[]` (e.g. `"Spice level: 4 → 2"`).

---

## 5. Client instructions (text / voice note)

```
Client: instruction (text and/or voice note; one-time or a standing daily order)
   ▼
SENT ──"Got it"──▶ ACKNOWLEDGED ──"Done"──▶ DONE                   (client told at each step)
   └──"Not my job" (reason)──▶ REFUSED ──▶ RM decides, both sides told:
                                         UPHELD     → stays REFUSED (outside the job)
                                         OVERTURNED → back to ACKNOWLEDGED (part of the job)
Client can cancel while SENT / ACKNOWLEDGED.
```
- A **standing order** (`kind: RECURRING`, e.g. "Check his feet every morning") is acknowledged once.
  It is never "done" (400 if you try).
- The refusal opens a Right-to-Refuse case. The RM decides it on the web (`/rm/care/refused`).

| Who | Method | Path | Body |
|---|---|---|---|
| all | GET | `/care/placements/:pid/instructions?status=` | — |
| client | POST | `/care/placements/:pid/instructions` | `{ text?, voice_file_id?, kind: ONE_TIME/RECURRING, due_at? (ISO), recurrence?: { times[], days[] } }`. Needs at least text or a voice note. |
| client | POST | `/client/instructions/:id/cancel` | — |
| staff | GET | `/staff/care/instructions?status=` | — returns `{ items[] }`, each with `client_name` |
| staff | POST | `/staff/care/instructions/:id/ack` | — ("Got it") |
| staff | POST | `/staff/care/instructions/:id/done` | `{ note? }` ("Done") |
| staff | POST | `/staff/care/instructions/:id/refuse` | `{ reason }` (required) |

Each instruction has: `status`, `text`, `voice_url` (play it with the token), `acknowledged_at`, `done_at`,
`refused_at`, `staff_note`, `rm_decision` (UPHELD/OVERTURNED), and `rm_note`. Show `rm_note` to both sides.

**Voice note:** record it, upload as `VOICE`, then send `voice_file_id`. On the staff side, play
`GET /care-files/:id` with the Bearer token. For staff who find reading hard, make **Play** the biggest
button on the card.

---

## 6. Staff sees every client input ("New from the family", "Mark as read")

This rule covers sections 3–5: whatever the family puts in the app for their staff
reaches that staff member's app, and the family can see that it was read.

| Endpoint (staff) | |
|---|---|
| `GET /staff/care/client-updates?placement_id=&unread=true` | `{ items[], unread }`, newest first. Each item: `{ type, id, version, placement_id, client_name, title, changes[], at, seen_at, acknowledged_at }` |
| `GET /staff/care/client-updates/unread-count` | `{ unread }`, for the **"New from the family"** home card badge |
| `POST /staff/care/client-updates/:type/:id/ack` | **"Mark as read"**. Use the `type` and `id` from the item. For `INSTRUCTION` this is the same as "Got it". |

| `type` | What it is | Who |
|---|---|---|
| `CARE_PLAN` | the active care plan + what changed in this version | caretaker |
| `FOOD_PROFILE` | the household food profile + what changed | cook |
| `MENU` | a menu slot the family set, or their answer to a suggestion | cook |
| `MEAL_FEEDBACK` | the family's rating of a meal | cook |
| `INSTRUCTION` | an instruction (status in `changes`) | everyone |

- **Show `changes[]` as highlighted lines.** The backend writes them, so don't diff anything yourself.
- Opening the feed marks items **seen**. Only the **Mark as read** button sets `acknowledged_at`.
- A **new version** (for example, the plan edited again) is a new unread item. Acknowledging an old
  version is refused (400).
- **Care plan banner:** in the caretaker's Today screen, while `plan.acknowledged === false`, show a banner
  over the checklist: "The care plan has changed — please read it first". Show `plan.changes` in it, with a **Mark as read** button.
- **The family sees it was read:** `staff_acknowledged_at` on `GET /care/placements/:pid/plan`, and
  `acknowledged_at` on instructions. The client also gets a notification ("Kavita read the care plan").
- **If the staff doesn't read it:** when a **medicine or check change** stays unread for 2 hours, the RM
  is notified once (so they can phone the staff member).

### Notifications for sections 3–6
In-app rows (`GET /client/notifications`, and the staff app's `GET /staff/notifications`). Push is not wired yet.

| `template` | To | When |
|---|---|---|
| `CARE_PLAN_UPDATED` | staff | plan saved |
| `CARE_PLAN_ACKNOWLEDGED` | client | staff read the plan |
| `CARE_PLAN_UNREAD` | RM | medical change unread 2h+ |
| `CARE_VITAL_ALERT` | client, RM (+BM if far out) | reading outside the range |
| `CARE_DOSE_MISSED` | client, RM | dose not ticked 1h after its time |
| `FOOD_PROFILE_UPDATED`, `MENU_UPDATED`, `MENU_APPROVED`, `MENU_REJECTED`, `MEAL_FEEDBACK` | cook | |
| `MENU_SUGGESTED`, `MEAL_LOGGED` | client | |
| `COOK_LOW_RATING` | RM | 7-day average < 3 (at most weekly) |
| `INSTRUCTION_NEW`, `INSTRUCTION_CANCELLED` | staff | |
| `INSTRUCTION_ACKNOWLEDGED`, `INSTRUCTION_DONE` | client | |
| `INSTRUCTION_REFUSED` | RM, client | |
| `INSTRUCTION_DECIDED` | staff, client | |

### Build checklist (sections 3–6)
- [ ] `placementId` and `features` from `/client/assigned-staff` drive which screens show
- [ ] File upload helper (multipart) + authenticated image/audio loader
- [ ] Client: care plan editor (keeps item `id`s; hides medicines/checks for UC), Today, History, monthly PDF
- [ ] Staff (caretaker): Today checklist, vitals input, skip reason, daily report, plan banner
- [ ] Client: food profile, week menu grid with warnings, approve/decline, meals feed, rating, suggestions
- [ ] Staff (cook): Today, log meal with optional photo, suggest menu
- [ ] Instructions on both sides, with voice notes and a big **Play** button
- [ ] Staff: "New from the family" card + feed with highlighted `changes[]` + **Mark as read**
- [ ] Client: "Read ✓" on care plan and instructions

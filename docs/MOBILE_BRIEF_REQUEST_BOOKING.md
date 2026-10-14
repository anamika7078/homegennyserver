# Mobile App Brief — Staff Request as a Booking

**14 Oct 2026 · This document has only the new changes.** It builds on the two earlier briefs (staff request,
care plan, cook, dish dropdown, start time, address). Where they disagree, **this document wins**.

Everything here is built on the backend and tested against live API calls.

**Common rules**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>" } }`. Show `message.message` as it is.
- All app text is English.

## The idea

The client's "Request staff" becomes a **booking**: everything the staff member needs is filled in up front, and
once the RM places someone, it is **already in the staff app** — nobody types the menu or care plan again.

```
Client: Home → Request staff → One-time visit / Regular staff → Date & time → Duration (one-time)
        → Dishes (cook) or Care needs (UC/SC) → Address + pin → Send
RM:     sees everything → shortlists → client chooses → RM places
Client: "Booking confirmed — <staff first name>, <date> <time>"
Staff:  the cook sees the dishes in Today; the caretaker sees care plan v1 and its tasks
```
Same flow for **Cook, UC and SC**. **No "Instant" for now** — every booking has a date and time.

## What changed, and on which screen

| What changed | App screen | Details |
|---|---|---|
| New first step: **One-time visit** or **Regular staff** | Client: Request Staff | §1 |
| **Date and time are now required** (both types) | Client: Request Staff | §1 |
| One-time visit: **Duration** 1 h / 1.5 h / 2 h / 3 h (replaces type + hours per day) | Client: Request Staff | §1 |
| Cook: **dishes** in the request (same dish dropdown as the menu) | Client: Request Staff | §2 |
| UC/SC: **care needs** in the request (medicines, vitals, activities, do's/don'ts) | Client: Request Staff | §3 |
| Request detail shows the booking (visit type, duration, dishes / care needs) | Client: request detail | §4 |
| New notification **"Booking confirmed"** (replaces "Your staff is on the way") | Client: notifications | §5 |
| Staff app: nothing new to build — the menu / care plan simply appears | Staff: Today | §5 |

## 1. Visit type, date & time, duration

`POST /client/staff-requests` — the new and changed fields:

| Field | Type | Rule |
|---|---|---|
| `visit_type` | `ONE_TIME` \| `REGULAR` | Default `REGULAR`. |
| `start_date` | `YYYY-MM-DD` | **Required.** Not in the past. |
| `start_time` | `HH:MM` (24 h) | **Required.** If the date is today, not already passed. |
| `duration_min` | `60` \| `90` \| `120` \| `180` | **Required for `ONE_TIME`**, ignored for `REGULAR`. |
| `placement_type`, `shift_hours` | as before | Only for `REGULAR`. For `ONE_TIME` the server sets `TEMPORARY` (by the hour) and `shift_hours = duration_min / 60`. |
| `menu` | object | Cook only — §2. Sending it for UC/SC is refused. |
| `care_needs` | object | UC/SC only — §3. Sending it for a cook is refused. |

Everything else (`series`, `address` + `lat`/`lng`, `requirements`, `language`, `gender_pref`, `notes`) is unchanged.

**Suggested screens**
1. **What kind of help?** Two cards: *One-time visit* ("A cook for a dinner party, a caretaker for an afternoon") /
   *Regular staff* ("Comes every day").
2. **When?** Date picker (today onwards) + time picker. Label: "Visit date & time" (one-time) or "Start date & time" (regular).
3. **How long?** One-time: chips `1 hour · 1.5 hours · 2 hours · 3 hours`.
   Regular: "Permanent (monthly)" / "Hourly" + hours per day, as today.
4. **Dishes** (cook) or **Care needs** (UC/SC).
5. **Address** + map pin, then **Review & send**.

**Errors you may show** (from the server, as is):
- `start_date is required — when should the staff come?`
- `start_time is required (HH:MM).`
- `duration_min is required for a one-time visit — one of 60, 90, 120, 180.`

## 2. Cook: dishes in the request

Dishes come from the **same dropdown** as the menu: `GET /care/dishes?q=&meal=` (see the earlier brief, §1),
including "+ Add as my dish" (`POST /client/dishes`).

**One-time visit** — the dishes for that visit (**at least 1 dish, required**):
```json
"menu": {
  "dish_ids": ["<id from the dropdown>", "<own dish id>"],
  "dishes": ["Typed name, if any"],
  "meal": "DINNER",
  "meal_time": "19:30",
  "special_instruction": "Less oil"
}
```
- `meal` is optional: if left out, the server picks it from the time — before 11:00 BREAKFAST, before 16:00 LUNCH,
  before 19:00 SNACKS, otherwise DINNER. Show the picked meal as a title ("Dinner menu").
- `meal_time` is optional; it defaults to `start_time`.
- **How many dishes fit the visit:**

  | Duration | Max dishes |
  |---|---|
  | 1 hour | 3 |
  | 1.5 hours | 4 |
  | 2 hours | 5 |
  | 3 hours | 7 |

  Show "Up to N dishes for 2 hours" and stop adding at the cap. Over the cap the server answers:
  `120 minutes covers up to 5 dishes — pick fewer dishes or a longer visit.`

**Regular cook** — an optional **weekly menu**, in the same format as the weekly template
(`PUT /client/menu-template`, earlier brief §3):
```json
"menu": { "items": [
  { "dow": "MON", "meal": "LUNCH", "dish_ids": ["…"], "meal_time": "13:00" },
  { "dow": "THU", "meal": "DINNER", "dishes": ["Grandma Khichdi"] }
] }
```
You can offer "Set the weekly menu now (optional)" or skip it — the client can always set it later from the menu screen.
If the client **already has** a weekly template, theirs is kept and this one is not applied.

## 3. UC/SC: care needs in the request

Optional, but recommended. **The same format as the care plan** (`PUT /care/placements/:pid/plan`, earlier brief),
so you can reuse those form pieces:
```json
"care_needs": {
  "patient": { "name": "Papa", "age": 80 },
  "medications": [ { "name": "Metformin", "dose": "500 mg", "times": ["09:00", "21:00"], "food_relation": "AFTER" } ],
  "vitals": [ { "type": "BP", "times": ["08:00"] } ],
  "activities": [ { "type": "WALK", "times": ["17:00"], "duration_min": 20 } ],
  "diet_notes": "Low salt",
  "dos": "Help him walk to the balcony",
  "donts": "No sugar in tea"
}
```
- `dos`, `donts`, `diet_notes` are **plain text** (one text box each), as in the care plan.
- `food_relation`: BEFORE, AFTER, WITH, ANY. `vitals[].type`: BP, SUGAR_FASTING, SUGAR_PP, SUGAR_RANDOM, … (same list as the care plan).
- **UC (Unskilled Caretaker): no medicines and no vitals.** Hide those two sections for UC. If sent anyway the server refuses:
  `An Unskilled Caretaker cannot give medicines or take vitals. …`
- **No prescription photo in the request.** Prescriptions are attached on the care plan after the booking is confirmed
  (the server refuses `prescription_file_id` here). Show a hint: "You can add the prescription after the booking is confirmed."

## 4. Request detail and list

`GET /client/staff-requests` and `GET /client/staff-requests/:id` now also return:
```json
{
  "visit_type": "ONE_TIME",
  "duration_min": 120,
  "placement_type": "TEMPORARY",
  "shift_hours": 2,
  "start_date": "2026-10-16",
  "start_time": "19:30",
  "menu": { "meal": "DINNER", "meal_time": "19:30",
            "dishes": [ { "name": "Dal Makhani" }, { "name": "Butter Roti" }, { "name": "Paneer Butter Masala" } ],
            "dish_ids": ["…", "…", "…"], "special_instruction": "Less oil" },
  "care_needs": null
}
```
- Regular cook: `menu` is `{ "items": [ … ] }` or `null`. UC/SC: `menu` is `null`, `care_needs` is the object from §3 (or `null`).
- **List card:** "One-time visit · 2 h · 16 Oct, 7:30 PM" or "Regular · Permanent · 12 h · from 16 Oct, 8:00 AM".
- **Detail:** a "Your booking" block with the dishes or care needs.

## 5. Booking confirmed — and what the staff sees

When the RM places someone from the request:

**Client** gets an in-app notification (`GET /client/notifications`):
- `template: "STAFF_REQUEST_CONFIRMED"`, title **"Booking confirmed"**,
  body like `Kamla — 2026-10-16 19:30 for 2 h (SR-2026-0042).`, payload `{ request_id, placement_id }`.
- Tap → open the request detail (status `FULFILLED`). This **replaces** `STAFF_REQUEST_FULFILLED` ("Your staff is on the way").

**Staff app — no new screens.** The existing screens just have data straight away:
- **Cook, one-time:** that day's menu slot is already filled (the cook gets `MENU_UPDATED` "Menu for your visit"), and it
  shows in the cook's Today on the visit date.
- **Cook, regular:** the weekly menu became the client's template and is applied for the next 14 days.
- **UC/SC:** care plan **v1** exists ("Care plan from your booking") with its tasks; the caretaker gets `CARE_PLAN_UPDATED`.

**After a one-time visit:** the placement is closed automatically the night after the visit
(status `EXITED`, `exit_scenario_code: "VISIT_DONE"`). It no longer appears as an active placement — no app change
needed, just don't treat it as an error if a one-time placement disappears from "active" lists the next day.

## Checklist for the app

- [ ] Request Staff: first step One-time visit / Regular staff → send `visit_type`.
- [ ] Date + time required on both; one-time shows Duration chips → send `duration_min`, don't send `placement_type`/`shift_hours`.
- [ ] Cook one-time: dish picker (dropdown + "Add as my dish"), cap by duration, optional instruction → `menu`.
- [ ] Cook regular: optional weekly menu step (template format) → `menu.items`.
- [ ] UC/SC: care-needs step (reuse the care-plan form; UC hides medicines and vitals) → `care_needs`.
- [ ] Review screen before sending.
- [ ] Request list/detail: show visit type, duration, date/time, dishes / care needs.
- [ ] Handle the `STAFF_REQUEST_CONFIRMED` notification ("Booking confirmed").

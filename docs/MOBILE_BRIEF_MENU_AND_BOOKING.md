# Mobile App Brief — Menu, Home Location and Staff Request as a Booking

**14 Oct 2026 · One document for everything still to build in the app.** It replaces two earlier briefs:
*Menu, Request and Home-Location Changes* and *Staff Request as a Booking*. You can drop both of them and use only this one.

It builds on the first brief (series, staff request, care plan, cook, instructions, client updates), which the app
already has. **Where this document disagrees with the first brief, this document wins.**

Everything here is built on the backend and tested against live API calls.

**Common rules**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>" } }`. Show `message.message` as it is.
- All app text is English.

## What changed, and on which screen

| What changed | App screen | Section |
|---|---|---|
| Dishes come from a **searchable dropdown**. If a dish isn't there, the client adds their own from the same search box. | Client: menu slot sheet | §1 |
| Each meal has a **time**: a default per meal in the food profile, or set on a single day. | Client: food profile + slot sheet; Cook: Today | §2, §4 |
| The client can attach **photos** to a meal ("make it like this"). | Client: slot sheet; Cook: Today | §2, §4 |
| **Weekly template** and **Same as last week** | Client: week menu | §3 |
| **Only the client sets the menu.** The cook's "Suggest menu" button goes away (the API returns 403). | Cook: remove "Suggest menu" | §4 |
| **Request Staff becomes a booking.** It starts with One-time visit / Regular staff, and date + time are required. | Client: Request Staff | §5 |
| One-time visit: **Duration** of 1 h, 1.5 h, 2 h or 3 h | Client: Request Staff | §5 |
| **Address is required** (with a map pin), and **budget is removed**. | Client: Request Staff | §5 |
| Cook request: **dishes** (the same dropdown as §1) | Client: Request Staff | §6 |
| UC/SC request: **care needs** (medicines, vitals, activities, do's/don'ts) | Client: Request Staff | §7 |
| Request detail shows the booking. **"Booking confirmed"** notification. | Client: request detail + notifications | §8, §9 |
| The client's **home location** (map pin), used to check staff check-ins | Client: profile | §10 |

---

# Part A — Menu

## 1. Dish dropdown and "Add as my dish"

**Search:** `GET /care/dishes?q=&meal=&category=&diet=&region=&limit=`
```json
{ "items": [ { "id": "…", "name": "Dhokla", "category": "BREAKFAST", "diet": "VEG", "jain_ok": true,
               "region": "GUJARATI", "meals": ["BREAKFAST","SNACKS"], "own": false } ],
  "total": 12,
  "filtered_by": { "diet": ["VEG"], "jain_only": false, "regions_first": ["GUJARATI"], "meal": "BREAKFAST" },
  "can_add": false }
```
- About 190 common Indian dishes, plus the client's own.
- **Filtered by the food profile:**
  - A VEG or VEGAN profile gets only veg dishes.
  - EGG gets veg and egg dishes.
  - JAIN gets Jain-friendly veg dishes.
  - The `diet` query can only narrow this, never widen it.
- **Order:** name starts with `q` → suits the slot's `meal` → the client's regions (from `cuisines`) → their own dishes.
- Send `meal` with the slot's meal, and search as the user types (debounce ~300 ms). `q` matches part of the name, and case doesn't matter.
- **`can_add: true`** → show one row under the results: **"+ Add '<typed text>' as my dish"**.

**Add:** `POST /client/dishes { name, category, diet, meals? }`
- `category`: BREAKFAST, DAL, SABZI, ROTI_PARATHA, RICE, SNACK, SALAD, SWEET, DRINK, OTHER.
- `diet`: VEG, EGG, NON_VEG (required).
- Returns `{ dish, existing }`. If the same name is already on the list or among their own dishes (case and spaces ignored), you get that dish with `existing: true`. Just select it.
- Only this client sees their own dishes.

**Manage own dishes:** `GET /client/dishes` and `DELETE /client/dishes/:id`. Menus that already use a deleted dish keep its name.

**Category picker for "Add"** (show the user these words):
- Breakfast · Dal · Sabzi · Roti/Paratha · Rice · Snack · Salad · Sweet · Drink · Other

## 2. Menu slot: dishes, time, note, photos

`PUT /care/placements/:pid/menu`:
```json
{ "items": [ {
    "date": "2026-10-15", "meal": "BREAKFAST",
    "dish_ids": ["<id from the dropdown>", "<own dish id>"],
    "dishes": ["Typed name, if any"],
    "meal_time": "08:45",
    "special_instruction": "Less oil",
    "servings": 4,
    "photo_file_ids": ["<PHOTO uploaded via POST /care-files>"]
} ] }
```
- Send what was picked as **`dish_ids`**. `dishes` (typed names) still works, and a typed name that matches the list is linked to it.
- `meal_time` is `HH:MM`. Leave it out to use the profile default.
- Each menu item now returns:
  - `meal_time`: the slot's own time, or the default
  - `meal_time_is_default`
  - `dishes[]`: each with `dish_id`, `diet` and `category`
  - `dish_ids` and `photo_file_ids`
  - `source`: `CLIENT`, or `TEMPLATE` when it was filled from the template
  - `health_warnings[]`
- Photos: at most 5 per meal, `kind: PHOTO`, uploaded by the client.
- **Warnings don't block saving.** Examples: `"Chicken Curry is non-veg — the profile says veg"`, `"diabetic: gulab jamun"`. Show them in yellow under the slot.
- **Clearing a slot:** send `dish_ids: []` and `dishes: []`. The slot stays empty, and the template does not fill it back.
- `GET …/menu?week=` returns `meal_times` (the profile defaults) next to `items`.

**Food profile:** `PUT /client/food-profile` takes `meal_times: { "BREAKFAST": "08:30", "LUNCH": "13:00", "SNACKS": "17:00", "DINNER": "20:30" }`.

## 3. Weekly template and "Same as last week"

- **`GET /client/menu-template`** returns `{ active, items[], updated_at }`.
- **`PUT /client/menu-template`**: `{ items: [{ dow: "MON"…"SUN", meal, dish_ids?, dishes?, meal_time?, special_instruction?, servings? }], active? }`
  - It fills the **empty** slots of every week from today on.
  - It **never** overwrites a slot the client set or cleared by hand.
  - Editing the template updates the slots it filled earlier.
  - Slots filled from the template have `source: "TEMPLATE"`.
  - The cook is notified.
- **`POST /care/placements/:pid/menu/copy-week`**: `{ from_week, to_week, overwrite? }`. A week is `2026-W42` or any date in it.
  - It copies one week onto another, for dates from today on.
  - Slots the client already set in the target week are kept unless `overwrite: true`.
  - Returns `{ copied, kept_existing, menu }`.
- Suggested buttons for the week view:
  - **"Use as my weekly menu":** there is no separate API for this.
    1. Take the week's `items` and turn each `date` into its weekday (`dow`).
    2. Keep `meal`, `dish_ids`, `dishes`, `meal_time`, `special_instruction` and `servings`.
    3. Send them with `PUT /client/menu-template`.
  - **"Same as last week":** calls copy-week.

## 4. Cook app

- `GET /staff/care/cook/today`: each meal's `menu` now has `meal_time`, `photo_file_ids`, `special_instruction` and `dishes[]`.
  - Show the **time** large on each meal card, and the client's photos as thumbnails.
  - Load photos with `GET /care-files/:id` and the Bearer token.
- **Remove the "Suggest menu" screen and button.** `POST /staff/care/cook/menu-suggestions` now always returns **403**.
- The client can still approve or decline old suggestions that are waiting.

---

# Part B — Staff request as a booking

The client's "Request staff" becomes a **booking**. Everything the staff member needs is filled in up front. Once
the RM places someone, it is **already in the staff app**, so nobody types the menu or the care plan again.

```
Client: Home → Request staff → One-time visit / Regular staff → Date & time → Duration (one-time)
        → Dishes (cook) or Care needs (UC/SC) → Address + pin → Review & send
RM:     sees everything → shortlists → client chooses → RM places
Client: "Booking confirmed — <staff first name>, <date> <time>"
Staff:  the cook sees the dishes in Today; the caretaker sees care plan v1 and its tasks
```
The flow is the same for **Cook, UC and SC**. **There is no "Instant" option for now**, so every booking has a date and time.

## 5. The request form: visit type, date & time, duration, address

`POST /client/staff-requests`. The table lists every field that is new or changed since the first brief:

| Field | Type | Rule |
|---|---|---|
| `visit_type` | `ONE_TIME` \| `REGULAR` | **New.** Default `REGULAR`. |
| `start_date` | `YYYY-MM-DD` | **Now required.** Not in the past. |
| `start_time` | `HH:MM` (24 h) | **New, required.** If the date is today, the time can't have passed already. |
| `duration_min` | `60` \| `90` \| `120` \| `180` | **New. Required for `ONE_TIME`**, ignored for `REGULAR`. |
| `placement_type`, `shift_hours` | as before | **Only for `REGULAR`.** For `ONE_TIME` the server sets `TEMPORARY` (paid by the hour) and `shift_hours = duration_min / 60`. |
| `address` | text | **Now required** (at least 5 characters). Remove "Leave empty to use your saved address". Prefill it from the profile so the client only confirms or edits it. |
| `lat`, `lng` | numbers | **New map pin.** Reuse `LocationAddressWidget`. Send both or neither. The first pin becomes the client's home location (§10). |
| `budget_min`, `budget_max` | — | **Remove the Budget section.** Values sent are ignored and are no longer returned. |
| `menu` | object | **New. Cook only** (§6). Sending it for UC/SC is refused. |
| `care_needs` | object | **New. UC/SC only** (§7). Sending it for a cook is refused. |

`series`, `requirements`, `language`, `gender_pref`, `headcount` and `notes` are unchanged.

**Suggested screens**
1. **What kind of help?** Two cards:
   - *One-time visit*: "A cook for a dinner party, a caretaker for an afternoon".
   - *Regular staff*: "Comes every day".
2. **When?** A date picker (today onwards) and a time picker, both required.
   - Label for one-time: "Visit date & time".
   - Label for regular: "Start date & time".
3. **How long?**
   - One-time: chips `1 hour · 1.5 hours · 2 hours · 3 hours`.
   - Regular: "Permanent (monthly)" / "Hourly" plus hours per day, as today.
4. **Needs:** the existing requirements (diet, people, meals / patient age, mobility…), plus **Dishes** (cook, §6) or **Care needs** (UC/SC, §7).
5. **Address** with a map pin.
6. **Review & send.**

**Errors you may show** (from the server, as is):
- `start_date is required — when should the staff come?`
- `start_time is required (HH:MM).`
- `start_time has already passed today.`
- `duration_min is required for a one-time visit — one of 60, 90, 120, 180.`
- `address is required — where will the staff work?`
- `Send lat and lng together.`

> The first menu brief said `start_time` was optional, and it listed the error "Give start_date along with start_time".
> **Both rules are gone**: date and time are now always required.

## 6. Cook request: dishes

Dishes come from the **same dropdown** as the menu (§1): `GET /care/dishes?q=&meal=`, including "+ Add as my dish".

**One-time visit:** the dishes for that visit. **At least one dish is required.**
```json
"menu": {
  "dish_ids": ["<id from the dropdown>", "<own dish id>"],
  "dishes": ["Typed name, if any"],
  "meal": "DINNER",
  "meal_time": "19:30",
  "special_instruction": "Less oil"
}
```
- `meal` is optional. If you leave it out, the server picks it from the time:

  | Visit starts | Meal |
  |---|---|
  | Before 11:00 | BREAKFAST |
  | 11:00 – 15:59 | LUNCH |
  | 16:00 – 18:59 | SNACKS |
  | 19:00 or later | DINNER |

  Show the picked meal as the title, for example "Dinner menu".
- `meal_time` is optional, and it defaults to `start_time`.
- **How many dishes fit the visit:**

  | Duration | Max dishes |
  |---|---|
  | 1 hour | 3 |
  | 1.5 hours | 4 |
  | 2 hours | 5 |
  | 3 hours | 7 |

  Show "Up to N dishes for 2 hours" and stop adding at the cap. Over the cap, the server answers:
  `120 minutes covers up to 5 dishes — pick fewer dishes or a longer visit.`
- With no dishes, the server answers: `menu needs at least one dish for a one-time cook visit.`

**Regular cook:** an optional **weekly menu**, in the same format as the weekly template (§3):
```json
"menu": { "items": [
  { "dow": "MON", "meal": "LUNCH", "dish_ids": ["…"], "meal_time": "13:00" },
  { "dow": "THU", "meal": "DINNER", "dishes": ["Grandma Khichdi"] }
] }
```
- You can offer "Set the weekly menu now (optional)" or skip it. The client can always set it later from the menu screen.
- If the client **already has** a weekly template, theirs is kept and this one is not applied.

## 7. UC/SC request: care needs

Care needs are optional, but recommended. They use **the same format as the care plan**
(`PUT /care/placements/:pid/plan`, first brief), so you can reuse those form pieces.
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
- `dos`, `donts` and `diet_notes` are **plain text**, one text box each, as in the care plan.
- `food_relation`: BEFORE, AFTER, WITH, ANY.
- `vitals[].type`: BP, SUGAR_FASTING, SUGAR_PP, SUGAR_RANDOM, … (the same list as the care plan).
- **UC (Unskilled Caretaker) gets no medicines and no vitals.** Hide those two sections for UC. If they are sent anyway, the server refuses:
  `An Unskilled Caretaker cannot give medicines or take vitals. …`
- **No prescription photo in the request.** Prescriptions are attached on the care plan after the booking is confirmed, and the server refuses `prescription_file_id` here.
  - Show a hint: "You can add the prescription after the booking is confirmed."

## 8. Request detail and list

`GET /client/staff-requests` and `GET /client/staff-requests/:id` now also return the following fields. `budget_*` are gone.
```json
{
  "visit_type": "ONE_TIME",
  "duration_min": 120,
  "placement_type": "TEMPORARY",
  "shift_hours": 2,
  "start_date": "2026-10-16",
  "start_time": "19:30",
  "address": "22 Green Park, New Delhi",
  "lat": 28.5592,
  "lng": 77.2066,
  "menu": { "meal": "DINNER", "meal_time": "19:30",
            "dishes": [ { "name": "Dal Makhani" }, { "name": "Butter Roti" }, { "name": "Paneer Butter Masala" } ],
            "dish_ids": ["…", "…", "…"], "special_instruction": "Less oil" },
  "care_needs": null
}
```
- **`menu`:** for a regular cook it is `{ "items": [ … ] }` or `null`. For UC/SC it is always `null`.
- **`care_needs`:** for UC/SC it is the object from §7, or `null`.
- **List card** examples:
  - "One-time visit · 2 h · 16 Oct, 7:30 PM"
  - "Regular · Permanent · 12 h · from 16 Oct, 8:00 AM"
- **Detail:** a "Your booking" block with the dishes or care needs.

## 9. Booking confirmed, and what the staff sees

When the RM places someone from the request, the **client** gets an in-app notification (`GET /client/notifications`):
- `template: "STAFF_REQUEST_CONFIRMED"`, with title **"Booking confirmed"**.
- The body looks like `Kamla — 2026-10-16 19:30 for 2 h (SR-2026-0042).`
- The payload is `{ request_id, placement_id }`.
- On tap, open the request detail (status `FULFILLED`).
- It **replaces** `STAFF_REQUEST_FULFILLED` ("Your staff is on the way").

**Staff app: no new screens.** The existing screens just have the data straight away:
- **Cook, one-time:**
  - That day's menu slot is already filled.
  - The cook gets `MENU_UPDATED` "Menu for your visit".
  - The menu shows in the cook's Today on the visit date, with its time (§4).
- **Cook, regular:** the weekly menu becomes the client's template and is applied for the next 14 days (§3).
- **UC/SC:**
  - Care plan **v1** exists ("Care plan from your booking") with its tasks.
  - The caretaker gets `CARE_PLAN_UPDATED`.

**After a one-time visit,** the placement closes by itself the night after the visit (status `EXITED`,
`exit_scenario_code: "VISIT_DONE"`). It no longer appears as an active placement. No app change is needed, but
don't treat it as an error when a one-time placement disappears from "active" lists the next day.

---

# Part C — Home location

## 10. Client home location

- **`PUT /client/home-location { lat, lng }`** comes from a map pin, for example in Profile → "My home on the map".
- The RM uses it to check that staff check in at the house. The RM can also set it from the web.
- If the client never sets it, the pin from their first staff request is used.

---

## Build checklist

**Menu**
- [ ] Menu slot sheet: search dropdown (`/care/dishes` with `meal`), "+ Add as my dish", and the selected dishes as chips
- [ ] Menu slot sheet: meal time picker, note, photo picker (upload PHOTO, then send `photo_file_ids`)
- [ ] Food profile: meal times (4 time pickers)
- [ ] Week menu: warnings, TEMPLATE label, "Use as my weekly menu", "Same as last week"
- [ ] My dishes list (with delete)
- [ ] Cook Today: time + photos. Remove "Suggest menu".

**Request Staff (booking)**
- [ ] First step: One-time visit / Regular staff → `visit_type`
- [ ] Date + time required on both types
- [ ] One-time: Duration chips → `duration_min`. Don't send `placement_type`/`shift_hours`.
- [ ] Address required and prefilled, with a map pin (`lat`, `lng`). Remove Budget.
- [ ] Cook one-time: dish picker (same dropdown + "Add as my dish"), capped by duration, optional instruction → `menu`
- [ ] Cook regular: optional weekly menu step (template format) → `menu.items`
- [ ] UC/SC: care-needs step (reuse the care-plan form; UC hides medicines and vitals) → `care_needs`
- [ ] Review screen before sending
- [ ] Request list/detail: visit type, duration, date/time, address, dishes / care needs
- [ ] Handle the `STAFF_REQUEST_CONFIRMED` notification ("Booking confirmed")

**Profile**
- [ ] "My home on the map" → `PUT /client/home-location`

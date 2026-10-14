# Mobile App Brief — Menu, Request and Home-Location Changes

**14 Oct 2026 · This document has only the new changes.** The app has already built everything in the earlier
brief (series, staff request, care plan, cook, instructions, client updates). The changes below **update** that work.
Where they disagree with the earlier brief, **this document wins**.

Everything here is built on the backend and tested against live API calls.

**Common rules**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>" } }`. Show `message.message` as it is.
- All app text is English.

## What changed, and on which screen

| What changed | App screen | Details |
|---|---|---|
| Dishes come from a **searchable dropdown**. If a dish isn't there, the client adds their own from the same search box. | Client: menu slot sheet | §1 |
| Each meal has a **time**: a default per meal in the food profile, or set on a single day. | Client: food profile + slot sheet; Cook: Today | §2, §4 |
| The client can attach **photos** to a meal ("make it like this"). | Client: slot sheet; Cook: Today | §2, §4 |
| **Weekly template** and **Same as last week** | Client: week menu | §3 |
| **Only the client sets the menu.** The cook's Suggest button is removed (the API returns 403). | Cook: remove "Suggest menu" | §4 |
| Staff request: **address is required** (with a map pin), there is a **start time**, and **budget is removed** | Client: Request Staff form | §5 |
| The client's **home location** (map pin), used to check staff check-ins | Client: profile or the first request | §6 |

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
- **Filtered by the food profile:** a VEG/VEGAN profile gets only veg dishes, EGG gets veg + egg, and JAIN gets Jain-friendly veg. The `diet` query can only narrow this, never widen it.
- **Order:** name starts with `q` → suits the slot's `meal` → the client's regions (from `cuisines`) → their own dishes.
- Send `meal` with the slot's meal, and search as the user types (debounce ~300 ms). `q` matches part of the name, and case doesn't matter.
- **`can_add: true`** → show one row under the results: **"+ Add '<typed text>' as my dish"**.

**Add:** `POST /client/dishes { name, category, diet, meals? }`
- `category`: BREAKFAST, DAL, SABZI, ROTI_PARATHA, RICE, SNACK, SALAD, SWEET, DRINK, OTHER.
- `diet`: VEG, EGG, NON_VEG (required).
- Returns `{ dish, existing }`. If the same name is already on the list or theirs (case and spaces ignored), you get that dish with `existing: true`. Just select it.
- Only this client sees their own dishes.

**Manage own dishes:** `GET /client/dishes`, `DELETE /client/dishes/:id`. Menus that already use a deleted dish keep its name.

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
- Send what was picked as **`dish_ids`**. `dishes` (typed names) still works; a typed name that matches the list is linked to it.
- `meal_time` is `HH:MM`. Leave it out to use the profile default.
- Each menu item now returns:
  - `meal_time`: the slot's own time, or the default
  - `meal_time_is_default`
  - `dishes[]`: each with `dish_id`, `diet` and `category`
  - `dish_ids`, `photo_file_ids`
  - `source`: `CLIENT`, or `TEMPLATE` when it was filled from the template
  - `health_warnings[]`
- Photos: at most 5 per meal, `kind: PHOTO`, uploaded by the client.
- **Warnings (they don't block):** `"Chicken Curry is non-veg — the profile says veg"`, `"diabetic: gulab jamun"`. Show them in yellow under the slot.
- **Clearing a slot:** `dish_ids: []` and `dishes: []`. It stays empty, and the template does not fill it back.
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
  - It copies one week onto another, dates from today on.
  - Slots the client already set in the target week are kept unless `overwrite: true`.
  - Returns `{ copied, kept_existing, menu }`.
- Suggested UI for the week view:
  - **"Use as my weekly menu"**: there is no separate API for this. Take the week's `items`, turn each `date` into its weekday (`dow`), keep `meal`, `dish_ids`, `dishes`, `meal_time`, `special_instruction` and `servings`, and send them with `PUT /client/menu-template`.
  - **"Same as last week"**: calls copy-week.

## 4. Cook app

- `GET /staff/care/cook/today`: each meal's `menu` now has `meal_time`, `photo_file_ids`, `special_instruction` and `dishes[]`.
  - Show the **time** large on each meal card, and the client's photos as thumbnails.
  - Load photos with `GET /care-files/:id` and the Bearer token.
- **Remove the "Suggest menu" screen and button.** `POST /staff/care/cook/menu-suggestions` now always returns **403**.
- Old suggestions that are still waiting can be approved or declined by the client as before.

## 5. Staff request form

| Field | Change |
|---|---|
| `address` | **Required** (at least 5 characters). Remove "Leave empty to use your saved address". Prefill it from the profile so the client only confirms or edits. |
| `lat`, `lng` | Add a **map pin**: reuse `LocationAddressWidget`. Send both or neither. The first pin becomes the client's home location. |
| `start_time` | New `HH:MM`. Show a time picker after the date; it needs `start_date`. A time that has already passed today is refused. |
| `budget_min`, `budget_max` | **Remove the Budget section.** Values sent are ignored, and they aren't returned any more. |

The request (client and RM views) now returns `start_time`, `lat` and `lng`; `budget_*` are gone.

New errors:
- "address is required — where will the staff work?"
- "Send lat and lng together."
- "Give start_date along with start_time."
- "start_time has already passed today."

## 6. Client home location

- **`PUT /client/home-location { lat, lng }`**: from a map pin (for example in Profile → "My home on the map").
- The RM uses it to check that staff check in at the house. The RM can also set it from the web.
- If the client never sets it, the first staff request pin is used.

## Build checklist
- [ ] Menu slot sheet: search dropdown (`/care/dishes` with `meal`) + "+ Add as my dish" + selected chips
- [ ] Menu slot sheet: meal time picker, note, photo picker (upload PHOTO, then `photo_file_ids`)
- [ ] Food profile: meal times (4 time pickers)
- [ ] Week menu: warnings, TEMPLATE label, "Use as my weekly menu", "Same as last week"
- [ ] My dishes list (with delete)
- [ ] Cook Today: time + photos; Suggest menu removed
- [ ] Request Staff form: address required + map pin, start time, budget removed
- [ ] Profile: "My home on the map" → `PUT /client/home-location`

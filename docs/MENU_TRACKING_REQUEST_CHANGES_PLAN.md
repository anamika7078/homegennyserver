# Final Plan — Client Menu, Check-in Map, Staff Request Changes

Date: 2026-10-14 · Scope: backend (`homegennyserver`) + web (`homegenny`). The app gets a new section in
`docs/MOBILE_BRIEF_CLIENT_CARE_COOK.md`.

Requested changes:
1. Dropdown for the menu
2. Creating the menu
3. Address compulsory
4. Tracking for staff
5. Client uploads a photo for the menu
6. Budget disabled
7. Date + time

> **Status (2026-10-14): ✅ Built locally (backend + web).**
> - Migration `scratch/_menu_request_changes_migration.js` + seed `scratch/_dishes_seed.js` (193 dishes).
> - Tests: `npm run test:menu` (50), `test:requests` (70), `test:care` (105), `test:series` (39), `test:rm` (120) — all pass.
> - Web: `/rm/checkins` (Leaflet + OpenStreetMap); request form/detail; menu time + photos on Daily Care.
> - Mobile brief: section 7.
> - **Prod:** run the migration + seed (`deploy/07_backend_menu_checkins.sh`).

## Decisions

| # | Decision |
|---|---|
| D1 | **Only the client creates the menu.** No admin page, no RM editing, and the cook's "suggest menu" is switched off. |
| D2 | The dish list is **fixed seed data** (~150–200 dishes). There is no admin page to manage it. |
| D3 | The client can **search** the list. If a dish isn't there, they add their own from the same search box. A client's own dish is visible only to that client. |
| D4 | "Tracking for staff" = **where the staff member checked in/out, shown on a map** (GPS is already saved). No live tracking. |

---

## 1. Client menu (points 1, 2, 5)

### Dish list (backend)
- New table **`dishes`**, filled with seed data:
  - `name`
  - `category`: BREAKFAST, DAL, SABZI, ROTI_PARATHA, RICE, SNACK, SALAD, SWEET, DRINK
  - `diet`: VEG / EGG / NON_VEG
  - `jain_ok`
  - `region`: NORTH_INDIAN, PUNJABI, SOUTH_INDIAN, GUJARATI, MAHARASHTRIAN, BENGALI, RAJASTHANI, OTHER
  - `meals[]`: which meals it suits
  - `active`
- A client's own dish goes in the same table with `client_id` filled in. Only that client sees it.

### Search + dropdown
- `GET /care/dishes?q=&meal=&category=&diet=&region=` returns the common list plus the client's own dishes.
  - **Filtered by the food profile:** a Veg/Jain profile gets no non-veg dishes. The client's region and cuisines come first.
  - **By meal:** in a Breakfast slot, breakfast dishes come first.
  - `q` searches by name (partial match, case doesn't matter).
- **Not found → add your own:** below the search results, show "+ Add '<typed name>' as my dish".
  - `POST /client/dishes { name, category, diet }` — the dish is saved straight away and selected.
  - A duplicate of the same name (common list or the client's own) is refused, and the existing dish is returned.
  - `GET /client/dishes` lists the client's own dishes. `DELETE /client/dishes/:id` removes one (dishes already used in a menu stay there).

### Building the menu
- For every day and meal (Breakfast / Lunch / Snacks / Dinner), the client picks dishes from the dropdown (`dish_id`). A typed name is still accepted, so old menus don't break.
- **Meal time:**
  - The food profile keeps default times (e.g. breakfast 08:30, lunch 13:00).
  - Each slot can override its `meal_time`.
  - The cook's Today screen shows the time.
- **Photo (point 5):** each slot takes `photo_file_ids[]`. The client uploads a `PHOTO` through `/care-files` (already built) and attaches it. The cook and the RM see it.
- **Weekly template:**
  - `PUT /client/menu-template` holds one week's pattern (day of week × meal → dishes, time, note).
  - The template fills the slots for upcoming weeks that the client has left empty. A slot the client set by hand is never overwritten.
  - "Same as last week": `POST /care/placements/:pid/menu/copy-week { from_week, to_week }`.
- **Warnings (they don't block):** a non-veg dish on a Veg profile, or a sweet for a diabetic, shows a warning on the slot.
- **Cook:** sees only the menu (time, dishes, note, photo) and keeps logging meals. `POST /staff/care/cook/menu-suggestions` is switched off (it returns 403 with a clear message). Existing SUGGESTED rows are left as they are.
- **RM web:** the Daily Care page shows the menu read-only, with time and photo.

## 2. Address compulsory (point 3)
- Staff request (client app and RM web): `address` is **required**, and `lat`/`lng` are taken when the pin is chosen.
- It no longer defaults to the saved address: the client confirms the address on every request.
- Web: the RM request form makes address a required field.

## 3. Check-in map (point 4)
- Backend: `GET /rm/checkins?date=&branch=` returns each check-in/out with the staff member, client, time and lat/lng.
  - It also gives the **distance from the client's home**, when the client address has a lat/lng.
  - It flags `far: true` when that distance is over 300 m.
- Web: a new page `/rm/checkins` with a map (Leaflet + OpenStreetMap, no Google key or cost) and a list beside it.
  - Far check-ins show in red.
  - Filters: date and branch.
  - Each point has an "Open in Google Maps" link.
- No live tracking, and no background location.

## 4. Budget removed (point 6)
- Backend: `budget_min`/`budget_max` are not accepted any more (ignored) and not returned. The DB column stays.
- Web: removed from the RM request form, the detail page and the list.

## 5. Date + time (point 7)
- Staff request: `start_time` (HH:MM, IST) next to `start_date`. Additive column.
- Web: a time picker in the RM form. The list and detail show date + time.

---

## Database changes (additive migration; nothing is dropped)
- `dishes` (new table, + seed data)
- `menu_plans`: + `meal_time`, + `photo_file_ids`, + `dish_ids` (the `dishes` JSON stays)
- `menu_templates` (new table, one per client)
- `food_profiles`: + `meal_times` (JSON)
- `staff_requests`: + `start_time`, + `lat`, + `lng`
- `clients`/`finance_customers`: + `lat`, + `lng` (for the check-in distance)

## Order
1. Small changes: 3, 6, 7 (staff request) + 5 (menu photo)
2. Menu: dishes + seed, search/add-own APIs, meal_time, template, copy-week, cook suggestions off
3. Check-in map
4. Live tests for every step + the mobile brief section + deploy (the low-CPU way, as before)

## For the mobile developer (brief section 7)
Dropdown + search + "Add as my dish", meal time, slot photo, template / same as last week, address required +
map pin, start time, budget removed, the cook's Suggest button removed.

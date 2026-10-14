# Plan — Staff Request as a Booking (details first, straight to the staff app)

Date: 2026-10-14 · Scope: backend + web; the app gets a separate mobile brief.

**Status: built and live-tested** (`npm run test:booking`, 35 checks). Not built: dish diet warnings in the request response (they show once the menu slot exists). Mobile brief: `MOBILE_BRIEF_REQUEST_BOOKING.md`.

## The flow we want
```
Client: Request → Visit type (One-time visit / Regular staff) → Date & time → Duration
        → Dishes (cook) or Care needs (UC/SC) → Address (+ pin) → Send
RM:     sees everything up front → shortlist → client chooses → RM places staff
        → "Booking confirmed" → the dishes / care needs are already in the staff app
```
Same flow for Cook, UC and SC. **No Instant for now:** only scheduled, so date + time are required.

## Today vs. what's needed

| Step | Today | Change |
|---|---|---|
| Visit type | Only PERMANENT / TEMPORARY | **New `visit_type`:** `ONE_TIME` (one visit) or `REGULAR` (daily) |
| Date + time | start_date / start_time optional | **Required** for both types |
| Duration | `shift_hours` (hours per day) | ONE_TIME: `duration_min` 60/90/120/180. REGULAR: `shift_hours` as today |
| Dishes (cook) | Only diet / people / meals | **New:** `menu` in the request (dish dropdown). ONE_TIME: dishes for that visit. REGULAR: a weekly pattern (template) |
| Care needs (UC/SC) | Age, mobility, conditions only | **New:** `care_needs` in the request: medicines, vitals, activities, diet, dos/don'ts (care-plan format, UC scope rule) |
| Booking confirmed | FULFILLED + "Your staff is on the way" | "**Booking confirmed** — <staff>, <date> <time>" |
| Staff app | The client has to make the menu / care plan again after placement | **Automatic:** when the placement is made from the request, the menu / care plan v1 is created and the staff member sees it |

## Backend

1. **Additive migration:** `staff_requests` gets `visit_type` (ONE_TIME | REGULAR, default REGULAR), `duration_min`, `menu` (jsonb) and `care_needs` (jsonb).
2. **Validation:**
   - `start_date` and `start_time` are required, and can't be in the past.
   - ONE_TIME: `duration_min` must be 60, 90, 120 or 180. `placement_type` is forced to TEMPORARY.
   - REGULAR: `placement_type` + `shift_hours` as today.
   - **Cook, ONE_TIME:**
     - `menu` = `{ meal?, meal_time?, dish_ids[], dishes[], special_instruction? }`, at least 1 dish.
     - Dish cap by duration: 60 min → 3, 90 → 4, 120 → 5, 180 → 7.
   - **Cook, REGULAR:**
     - `menu` = `{ items: [{ dow, meal, dish_ids, dishes, meal_time }] }` (the weekly template format). Optional, but recommended.
   - Dishes are resolved through the existing dish list / own dishes. The client's diet warnings are returned.
   - **UC/SC:**
     - `care_needs` in the care-plan format: patient, medications, vitals, activities, diet_notes, dos, donts.
     - It is checked with the same parser as the care plan, so UC gets no medicines or vitals.
     - Optional, but recommended.
3. **RM view:** the request detail shows visit type, date/time, duration, dishes (with warnings) and care needs.
4. **Placement from the request** (`POST /placements` with `staff_request_id`):
   - The placement takes its defaults from the request:
     - ONE_TIME: TEMPORARY, trial start = start_date, hours = duration/60.
     - REGULAR: as today.
   - **Cook, ONE_TIME:** the dishes become the menu slot for that date and meal (`source: CLIENT`).
   - **Cook, REGULAR:** the weekly menu becomes the client's template, but only if they don't have one yet, and is applied for the next 14 days.
   - **UC/SC:** `care_needs` becomes **care plan v1** for the placement, and the staff member is notified.
   - The client gets "**Booking confirmed**", with the staff member's first name, date and time.
5. **ONE_TIME after the visit:**
   - The placement is a TEMPORARY placement for that day.
   - A daily cron marks ONE_TIME placements whose date has passed as **completed (exited, `exit_scenario_code: VISIT_DONE`)**, so they don't stay "active".
   - Billing works as for TEMPORARY placements (by the hour).

## Web (RM)
- New request form: visit type, date + time (required), duration (ONE_TIME), dish picker (cook) or a short care-needs form (UC/SC).
- Request detail: all of the above. The "Create trial placement" prefill uses the request's terms.
- List: visit type + date/time.

## Tests
- A ONE_TIME cook request with dishes → placement → that day's menu exists → the cook's Today shows it → the client gets "Booking confirmed".
- REGULAR cook → template applied. UC/SC with care needs → care plan v1 exists → the caretaker's Today has the tasks.
- Validation: missing date/time, dish cap, UC medicines refused, invalid duration.
- ONE_TIME completion cron.

## Mobile brief
A separate doc (`MOBILE_BRIEF_REQUEST_BOOKING.md`) for the client app's request form steps and the confirmation screen.

## Out of scope (for now)
Instant booking, on-demand pricing / payment, live tracking.

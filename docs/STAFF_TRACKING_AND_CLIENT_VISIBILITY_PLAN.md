# Plan — Staff Check-in Fixes, Live Location and Staff Details for the Client

Date: 2026-10-15 · Scope: backend + web (RM). The app gets a separate mobile brief once this is built and tested.

**Status: built and live-tested** (`npm run test:tracking`, 41 checks; test:hr, test:care, test:menu, test:booking, test:requests, test:series, test:rm and the attendance drift suite still pass). Mobile brief: `MOBILE_BRIEF_STAFF_TRACKING.md`. Not tested live: the photo stream with a real photo on file (no photo documents in the local database).

## Decisions (from the product owner)
- **Tracking:** while the staff member is checked in, the staff app sends their location **about every 5 minutes**.
  The client sees the last location on a map, plus "At home" or "1.2 km from home". Tracking stops at check-out,
  and the client never sees the location outside a shift.
- **Staff details:** the client sees a full profile **including the staff phone number**. The client never sees the
  Aadhaar number, the full home address, bank details or documents.

## What is wrong today (found 2026-10-14)

| # | Problem | Effect |
|---|---|---|
| 1 | Check-in works only for a **CONFIRMED** placement | Trial staff can't check in. **One-time visits stay TRIAL, so they can never check in.** |
| 2 | Check-in tells **nobody** | The client has to open the app to find out |
| 3 | `GET /client/attendance/today` returns **one** staff member (the newest placement) | A house with a cook and a caretaker sees only one of them |
| 4 | `GET /client/attendance/history` lists **every day of the staff member**, not just this client's days | A client sees the staff member's days at other houses (privacy) |
| 5 | Check-in always goes to the staff member's **newest** placement; `shift_logs` allows one row per staff per day | Staff who work at several houses can't check in at the second house |
| 6 | "Today" is the **UTC** date | A check-in between 00:00 and 05:30 IST lands on the previous day |
| 7 | `GET /client/staff/:id/profile` returns only name, code, series and a verified flag. A CLIENT login with no customer record can open **any** staff profile. | The client knows almost nothing about who is in their house, and there is a hole in the access check |

## Backend

### A. Check-in / check-out (staff app)
1. **Which placements can check in:** TRIAL and CONFIRMED. Trial days are already billed and paid, because invoices
   and payroll count TRIAL, so nothing changes for money.
   - **One-time visits** can check in only on the visit date.
2. **Which placement:** `POST /staff/attendance/check-in` takes an optional `placement_id`.
   - **Without it:** if the staff member has one active placement, it is used. With several, the server picks the
     one whose client home is nearest to the GPS point. If no home is set, it asks: "Choose where you are checking in".
   - The response says which client it checked in at.
   - `GET /staff/deployment` (or a new `GET /staff/placements/active`) lists the active placements for the picker.
3. **One shift row per staff, placement and day** (fixes #5):
   - Additive-safe migration: add a unique index `(staff_id, placement_id, shift_date)`, then drop the old
     `(staff_id, shift_date)` unique. Existing rows are already unique by the triple, so no data changes.
   - The 8 places that use the old key are updated: staff check-in/out/history, client attendance, the RM service,
     the attendance mirror and the seed.
   - Check-out closes the open shift (the one checked in and not out).
   - A staff member can't be checked in at two houses at once: check out first.
4. **IST "today"** everywhere in check-in, check-out and client attendance (fixes #6).
5. **Distance check:** at check-in and check-out, the server stores the distance from the client home
   (`finance_customers.lat/lng`, from the map pin already built).
6. **Notifications to the client** (fixes #2): `STAFF_CHECKED_IN` and `STAFF_CHECKED_OUT`.
   - Check-in example: "Asha checked in at 8:02 AM · at home".
   - Check-out example: "Asha checked out at 6:10 PM · 10 h 08 m".
   - If the check-in was over 300 m from home, the RM gets told too.

### B. Location during the shift (new)
1. **Table `staff_location_pings`** (additive):

   | Column | Notes |
   |---|---|
   | `id` | |
   | `staff_id` | |
   | `placement_id` | |
   | `shift_log_id` | |
   | `lat`, `lng` | |
   | `accuracy_m` | |
   | `battery_pct` | Optional |
   | `recorded_at` | Phone time |
   | `created_at` | |

   Index on `(placement_id, recorded_at)`.
2. **`POST /staff/attendance/location`**:
   - Body: `{ points: [{ latitude, longitude, accuracy?, battery?, recorded_at }] }`. A batch, so points collected
     offline are sent when the network is back.
   - Accepted only while the staff member is checked in, and only points inside the open shift (between check-in
     and now).
   - At most one stored point per 2 minutes; extra points are dropped. At most 50 points per call.
   - Returns `{ accepted, next_in_sec: 300 }`, so the server can change the interval without an app release.
3. **Left the house:** if two points in a row are over 300 m from home during the shift, the client and the RM get
   `STAFF_AWAY_FROM_HOME` once ("Asha is 1.2 km from home"). Coming back resets it.
4. **Kept 30 days.** A nightly cron deletes older points.
5. **Stale:** no point for 20 minutes during a shift shows "Location not updated since 3:40 PM". This could mean
   the phone is off or location is disabled.

### C. What the client sees
1. **`GET /client/attendance/today`** (fixes #3):
   - Returns `staff: [ … ]`, one entry per active placement, with status, check-in/out times, at home or
     distance, and the last location time.
   - The old top-level fields stay for the first staff member, so the current app keeps working.
2. **`GET /client/attendance/history?staff_id=&from=&to=`** (fixes #4): only this client's placements' days.
3. **`GET /client/staff/:staffId/location`** (new):
   ```json
   {
     "status": "PRESENT",
     "check_in": { "at": "…", "lat": 0, "lng": 0, "distance_m": 40 },
     "last": { "at": "…", "lat": 0, "lng": 0, "accuracy_m": 15, "distance_m": 60, "at_home": true, "stale": false },
     "home": { "lat": 0, "lng": 0 },
     "trail": [ { "at": "…", "lat": 0, "lng": 0 } ]
   }
   ```
   - `trail` is today's points for this placement only.
   - Outside a shift, it returns `status` with `last: null`, so the location is never shown off-shift.
4. **`GET /client/staff/:staffId/profile`** (fixes #7):
   - **Access:** only staff with a placement at this client, current or past. For a CLIENT login with no customer
     record, the answer is 403.
   - **Returns:**
     - photo (`photo_url` → `GET /client/staff/:staffId/photo`, streamed with the client token)
     - full name, age (from date of birth), gender
     - languages / language tier, city or hometown, experience in years
     - series with its label
     - **phone**
     - emergency contact **name** (not number)
     - verification badges: police verification, ID check, video certificate, training
     - the placement: type, start date, shift hours, status (Trial / Active / Ended)
     - the RM's name and phone
   - **Never returned:** Aadhaar, full address, bank details, documents, salary.
   - **Photo:** the latest staff document whose type is a photo (e.g. "Photo", "Passport photo"). With none,
     `photo_url: null` and the app shows initials.

### D. Web (RM)
- **Check-ins map:** for a checked-in staff member, show the latest location and today's trail, not just the
  check-in point.
- **RM request/placement pages:** nothing new.

## Tests (live, scratch/_live_test_staff_tracking.js)
- Trial staff checks in → 200.
- A one-time visit checks in on its date; on another date it is refused.
- A staff member with two placements:
  - Checks in with `placement_id` at house B.
  - Without it, the nearest home is chosen.
  - A second check-in while still checked in is refused.
  - After check-out, they can check in at house A the same day.
- The IST date is right for a check-in at 00:30 IST (simulated).
- The client is notified on check-in and check-out; the RM is notified when the check-in is far from home.
- Location points:
  - Accepted while checked in; refused when not checked in.
  - Thinned to one per 2 minutes.
  - Two far points in a row → `STAFF_AWAY_FROM_HOME` once.
- Client location view:
  - Shows `last`, `at_home` and `trail` during the shift.
  - `last: null` after check-out.
  - Another client gets 403.
- Client attendance:
  - `today` lists both staff members.
  - `history` has no days from the other house.
- Client profile:
  - The new fields and the phone are there.
  - No Aadhaar, address or bank details.
  - Another client's staff → 403.
- Cleanup cron deletes points older than 30 days.
- Existing suites still pass: `test:hr` (staff check-in visibility), `test:care`, `test:booking`, `test:rm`.

## Mobile brief (after the build)
A separate document covering:
- **Staff app:**
  - Check-in with a placement picker.
  - Location every 5 min while checked in (foreground service on Android, with a "Sharing location while on
    duty" notification).
  - The consent text and the permission flow.
- **Client app:**
  - The today list for several staff members.
  - A live map screen.
  - The full staff profile with a call button.
  - The new notifications.

## Out of scope (for now)
- Real-time (30-second) tracking.
- Location outside a shift.
- Geofence-based automatic check-in.
- Showing the trail for past days to the client (the RM can see it for 30 days).

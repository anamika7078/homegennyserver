# Mobile App Brief — Check-in Fixes, Live Location and Staff Profile

**15 Oct 2026 · New work for both apps.** This builds on the earlier briefs. Where they disagree, this one wins.
Everything here is built on the backend and tested against live API calls. The JSON samples below come from a real test run,
with ids shortened and test names replaced by readable ones.

**Common rules**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>" } }`. Show `message.message` as it is.
- All app text is English.
- Times in responses are UTC ISO strings. Show them in IST.
- Notifications are in-app only (`GET /client/notifications`); push (FCM) is not wired yet.

## What changed, and on which screen

| What changed | App | Section |
|---|---|---|
| **Trial staff and one-time visits can now check in.** Before, only confirmed placements could. | Staff | §1 |
| Staff who work at **more than one house** pick the house when they check in | Staff | §1 |
| **Location every 5 minutes** while checked in (stops at check-out) | Staff | §2 |
| Today shows **every staff member** in the home, not just one | Client | §3 |
| **Live map**: where the staff member is now, "At home" or "1.2 km from home", today's path | Client | §4 |
| **Full staff profile** with photo, phone (call button), age, experience, verification, RM | Client | §5 |
| History shows only days worked **at this home** | Client | §6 |
| New notifications: checked in, checked out, away from home | Client | §7 |

---

# Part A — Staff app

## 1. Check-in and check-out

### Where can I check in today — `GET /staff/placements`
```json
{
  "date": "2026-10-15",
  "checked_in_at": null,
  "location_interval_sec": 300,
  "placements": [
    { "placement_id": "777de0a6-…", "client_name": "Sharma Household", "address": "1 Test Lane, New Delhi",
      "home": { "lat": 28.6, "lng": 77.25 }, "placement_type": "PERMANENT", "visit_type": "REGULAR", "today": "NOT_CHECKED_IN" },
    { "placement_id": "edc4fd87-…", "client_name": "Verma Household", "address": "1 Test Lane, New Delhi",
      "home": { "lat": 28.5592, "lng": 77.2066 }, "placement_type": "TEMPORARY", "visit_type": "REGULAR", "today": "NOT_CHECKED_IN" }
  ]
}
```
- It lists trial and confirmed placements. A one-time visit appears only on its date.
- `today`: `NOT_CHECKED_IN` | `CHECKED_IN` | `CHECKED_OUT`.
- `checked_in_at`: the placement that has an open shift right now, or `null`.
- `home` can be `null` when the client has not set a home pin.

**Check-in screen:**
- **One house:** a single "Check in" button, as today.
- **Several houses:** show a list (client name + address) and send the chosen `placement_id`.
- If the app sends no `placement_id`, the server picks the house nearest to the GPS point. You can pre-select
  that house, but let the staff member change it.

### `POST /staff/attendance/check-in`
Body: `{ "latitude": 28.5594, "longitude": 77.2066, "placement_id": "edc4fd87-…" }`. `placement_id` is optional
when there is only one house.
```json
{
  "success": true, "attendanceId": "29a6f5e3-…", "status": "CHECKED_IN", "already_checked_in": false,
  "placement_id": "edc4fd87-…", "client_name": "Verma Household",
  "latitude": 28.5594, "longitude": 77.2066, "distance_m": 22, "at_home": true,
  "timestamp": "2026-10-15T07:37:48.476Z", "location_interval_sec": 300
}
```
- Show "Checked in at Verma Household".
  - If `at_home` is `false`, also warn: "You are 1.2 km from the client's home". The RM is told about it.
- Pressing it twice is harmless: you get `already_checked_in: true`.
- After a check-out, checking in again at the **same** house the same day (for example after lunch) reopens the
  day. The hours still run from the first check-in.
- **Start sending the location** (§2).

**Errors** (show them as they come):
- `You are checked in at Verma Household — check out there first.`
- `You work at more than one house — choose where you are checking in (placement_id).` → show the house list.
- `Your visit is on 2026-10-16 — you can check in on that day.` (one-time visit)
- `No active placement — you can check in once your RM has placed you.`

### `POST /staff/attendance/check-out`
Body: `{ "latitude": 28.5592, "longitude": 77.2066 }`. `placement_id` is optional, because the open shift is found
without it.
```json
{
  "success": true, "attendanceId": "29a6f5e3-…", "status": "CHECKED_OUT", "placement_id": "edc4fd87-…",
  "latitude": 28.5592, "longitude": 77.2066, "distance_m": 0, "worked": "0 h 30 m",
  "timestamp": "2026-10-15T07:37:48.736Z"
}
```
- Show "Checked out · 0 h 30 m".
- **Stop sending the location.**
- Error: `You have already checked out today.`
- For an hourly placement, the hours worked are now saved on the day automatically. This is what the client is
  billed on.

## 2. Location while checked in

`POST /staff/attendance/location`:
```json
{ "points": [
  { "latitude": 28.5592, "longitude": 77.2066, "accuracy": 12, "battery": 80, "recorded_at": "2026-10-15T07:17:48Z" },
  { "latitude": 28.5700, "longitude": 77.2066, "recorded_at": "2026-10-15T07:27:48Z" }
] }
```
Response: `{ "accepted": 2, "dropped": 0, "next_in_sec": 300 }`
- **When:** every `location_interval_sec` / `next_in_sec` seconds (300 = 5 minutes) from check-in to check-out.
  Use the number the server sends, so the interval can change without an app release.
- **Offline:** keep points in a local queue with their `recorded_at`, and send them together when the network is
  back. Send at most 50 points per call.
- The server drops points closer than 2 minutes apart, points from before the check-in, and points sent when not
  checked in. Dropped points are counted in `dropped` and are not an error.
- After check-out the endpoint answers 400: `You are not checked in — location is shared only during a shift.`
  Clear the queue when you see this.
- `accuracy` (metres) and `battery` (%) are optional but useful.

**How to run it (Flutter):**
- **Android:**
  - Run a **foreground service** with type `location` while checked in. It shows a persistent notification:
    "HomeGenny — Sharing your location while on duty".
  - Permissions: `ACCESS_FINE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` (Android 14+) and
    `POST_NOTIFICATIONS` (13+).
  - Start the service while the app is open (at check-in). Then "while using the app" location permission is
    enough, and you don't need `ACCESS_BACKGROUND_LOCATION`.
  - With `geolocator`, use `AndroidSettings(intervalDuration: 5 min, foregroundNotificationConfig: …)`.
- **iOS:**
  - Add the `location` background mode and `NSLocationWhenInUseUsageDescription`.
  - With `geolocator`, use `AppleSettings(allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true)`.
  - iOS has no fixed interval, so throttle in the app to one point per ~5 minutes.
- **Play Store:** using a location foreground service needs a declaration in the Play Console (a short video of
  the feature). Plan for it before the release.

**Consent (required by the stores, and the right thing to do):** before the first check-in that needs the
location, show a screen:
> "While you are checked in, HomeGenny shares your location with the family and your RM about every 5 minutes.
> It stops when you check out. Your location is never shared when you are not on duty."
> **[I understand]**

Then ask for the location permission. If the permission is denied, check-in still works without GPS. Show
"Location is off — the family can't see where you are", and send no points.

---

# Part B — Client app

## 3. Today: every staff member in the home — `GET /client/attendance/today`
```json
{
  "staffCode": "ZT-Kam-67361", "staffName": "Kamla", "todayStatus": "NOT_CHECKED_IN",
  "checkInTime": null, "checkOutTime": null, "gpsVerified": false, "date": "2026-10-15",
  "staff": [
    { "staff_id": "dc48ae7d-…", "placement_id": "d70d0903-…", "staff_code": "ZT-Kam-67361", "name": "Kamla Devi",
      "series": "COOK", "series_label": "Cook", "status": "NOT_CHECKED_IN",
      "check_in": null, "check_out": null, "gps_verified": false, "check_in_distance_m": null, "last_location": null },
    { "staff_id": "334eeac7-…", "placement_id": "edc4fd87-…", "staff_code": "ZT-Ash-67358", "name": "Asha Kumari",
      "series": "UNSKILLED_CARE", "series_label": "Caretaker (UC)", "status": "PRESENT",
      "check_in": "2026-10-15T07:07:48.555Z", "check_out": null, "gps_verified": true, "check_in_distance_m": 22,
      "last_location": { "at": "2026-10-15T07:39:18.591Z", "lat": 28.57, "lng": 77.2066, "accuracy_m": null,
                         "distance_m": 1201, "at_home": false, "label": "1.2 km from home", "stale": false } }
  ]
}
```
- **Use `staff[]`.** It has one card per staff member working at this home.
- The top-level fields (`todayStatus`, `staffName` …) are the first staff member only. They are kept for older app
  builds; don't use them in new screens.
- `status`: `NOT_CHECKED_IN` | `PRESENT` | `CHECKED_OUT`.
- **Card:**
  - name and series
  - status chip: Not checked in / Present / Checked out
  - "In 12:37 PM"
  - `last_location.label` ("At home" in green; "1.2 km from home" in red)
  - "View on map" (§4)
- If `last_location.stale` is `true`, show "Location not updated since 3:40 PM". It may mean the phone is off or
  location is disabled.

## 4. Live map — `GET /client/staff/:staffId/location`
```json
{
  "staff_id": "334eeac7-…", "placement_id": "edc4fd87-…", "status": "PRESENT",
  "check_in": { "at": "2026-10-15T07:07:48.555Z", "lat": 28.5594, "lng": 77.2066, "distance_m": 22, "label": "at home" },
  "check_out": null,
  "last": { "at": "2026-10-15T07:39:18.591Z", "lat": 28.57, "lng": 77.2066, "accuracy_m": null,
            "distance_m": 1201, "at_home": false, "label": "1.2 km from home", "stale": false },
  "home": { "lat": 28.5592, "lng": 77.2066 },
  "trail": [ { "at": "2026-10-15T07:17:48.546Z", "lat": 28.5592, "lng": 77.2066 },
             { "at": "2026-10-15T07:27:48.546Z", "lat": 28.57, "lng": 77.2066 } ],
  "far_meters": 300,
  "next_refresh_sec": 60
}
```
- **Map:** use the map package the app already has (the one behind `LocationAddressWidget`).
  - Home marker (house icon), and a 300 m circle around it (`far_meters`).
  - The staff member's marker at `last`, with their photo or initials.
  - `trail` drawn as a thin line.
- **Header:**
  - "Asha · Present since 12:37 PM"
  - `last.label`
  - "Updated 2 min ago", from `last.at`
- **Refresh** every `next_refresh_sec` seconds (60) while the screen is open. When it is `null`, there is nothing
  to refresh.
- **Outside the shift** `last` is `null` and `trail` is `[]`. This is by design: the location is never shown
  off-duty.
  - After check-out, show "Checked out at 6:10 PM".
  - Before check-in, show "Not checked in yet".
- **403** `This staff member does not work at your home.` means the staff member is not placed at this home.
- If `home` is `null`, there is no home pin yet. Show "Set your home on the map" with a link to Profile →
  "My home on the map" (`PUT /client/home-location`, earlier brief).

## 5. Staff profile — `GET /client/staff/:staffId/profile`
```json
{
  "staff_id": "334eeac7-…", "staff_code": "ZT-Ash-67358", "full_name": "Asha Kumari", "first_name": "Asha",
  "photo_url": null, "phone": "6498673570", "age": 36, "gender": "FEMALE",
  "series": "UNSKILLED_CARE", "series_label": "Caretaker (UC)",
  "language_tier": null, "language_tier_label": null,
  "city": "New Delhi", "hometown": "Agra", "experience_years": 6,
  "emergency_contact_name": "Sunita Devi",
  "verification": { "is_verified": false, "police_verification": "CLEAR", "id_verified": false,
                    "health_screening": null, "video_certified": false, "trained": true },
  "placement": { "placement_id": "edc4fd87-…", "status": "TRIAL", "status_label": "On trial",
                 "placement_type": "TEMPORARY", "visit_type": "REGULAR", "start_date": "2026-10-15", "shift_hours": 8 },
  "rm": { "name": "Pooja Mishra", "phone": "9800000002" },
  "staffId": "…", "staffCode": "…", "fullName": "…", "isVerified": false, "pvStatus": "CLEAR", "videoCertAvailable": false
}
```
- **Who can see it:** only staff placed at this home, now or before. Others → 403.
- **Never in the response:** Aadhaar, home address, bank, documents, salary, the emergency contact's number.
- **Photo:** `photo_url` is a path (`/client/staff/:id/photo`). Load it with the Bearer token, e.g.
  `Image.network(baseUrl + photo_url, headers: {Authorization: …})`. When it is `null`, or the photo call returns
  404, show initials.
- **Call button:** use `phone` to open the dialer. Also add "Call RM" with `rm.phone`.
- **Show:**
  - age · gender · hometown · "6 years experience"
  - `series_label`
  - "On trial since 15 Oct" (`placement.status_label`, `start_date`)
  - emergency contact name
- Any field can be `null`. Hide the row when it is.
- **Verification badges:**

  | Badge | Shown when |
  |---|---|
  | Police verified | `police_verification === "CLEAR"` |
  | ID verified | `id_verified` |
  | Health checked | `health_screening === true` |
  | Video certified | `video_certified` |
  | Trained | `trained` |

  If `health_screening` is `null`, the check doesn't apply to this series, so hide the badge.
- The camelCase fields at the end (`staffId`, `isVerified` …) are kept for older builds.

## 6. History — `GET /client/attendance/history?staff_id=&from=&to=`
```json
{ "from": "2026-09-16", "to": "2026-10-15", "totalPresent": 1, "totalAbsent": 0,
  "history": [ { "date": "2026-10-15", "staff_id": "334eeac7-…", "staff_name": "Asha Kumari", "placement_id": "edc4fd87-…",
                 "status": "PRESENT", "checkIn": "2026-10-15T07:07:48.555Z", "checkOut": "2026-10-15T07:37:48.736Z", "worked": "0 h 30 m" } ] }
```
- **Only days worked at this home.** Before this change, days at other houses could appear.
- Default range is the last 30 days. Use `from` and `to` (YYYY-MM-DD, at most 3 months apart) and `staff_id` to
  filter one staff member.
- Several staff in the home → show a staff filter (from `staff[]` in §3).

## 7. Notifications (in-app)

| `template` | Title | Body (example) | On tap |
|---|---|---|---|
| `STAFF_CHECKED_IN` | Asha checked in | Checked in at 1:07 PM · at home | Map (§4) |
| `STAFF_AWAY_FROM_HOME` | Asha is away from home | Asha Kumari is 1.2 km from home during the shift (1:06 PM). | Map (§4) |
| `STAFF_CHECKED_OUT` | Asha checked out | Checked out at 1:07 PM · 0 h 30 m | History (§6) |

- The payload is `{ placement_id, staff_id, shift_id }` (plus `distance_m` for away).
- "Away from home" is sent once when two location points in a row are more than 300 m from home. The RM gets it
  too. It is sent again only after the staff member has come back home.

---

## Build checklist

**Staff app**
- [ ] Check-in: use `GET /staff/placements`; with several houses show a picker and send `placement_id`
- [ ] Check-in result: client name; warn when `at_home` is false; handle the new errors
- [ ] Consent screen + location permission flow
- [ ] Foreground location service from check-in to check-out, one point every `location_interval_sec`
- [ ] Offline queue for points (batch ≤ 50, keep `recorded_at`); clear on the "not checked in" 400
- [ ] Check-out: show `worked`, stop the service

**Client app**
- [ ] Today: a card per entry of `staff[]` (status, times, location label, stale warning)
- [ ] Map screen: home + 300 m circle, staff marker, trail, refresh every 60 s, off-shift states
- [ ] Staff profile: photo with token, call staff, call RM, details, verification badges
- [ ] History: staff filter, date range
- [ ] Notifications: the three new templates, open the map or history on tap

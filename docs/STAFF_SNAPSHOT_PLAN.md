# Staff Snapshot — RM (web) and Client (app)

**21 Oct 2026 · Built 2026-10-21** (backend, RM web, mobile brief `docs/MOBILE_BRIEF_STAFF_SNAPSHOT.md`; `npm run test:snapshot`). Decisions taken: all five as recommended below.

Request from the client: *"Create a snapshot where I could track staff availability, current deployment and daily
work alignment status — one for RM, and one for client."*

Scope agreed with the user:
- **RM snapshot: web only.** The RM mobile app is not touched for now.
- **Client snapshot: mobile app.** We build the backend; the app dev gets a brief.

## What already exists (and is reused)

| Piece | Where today | Gap for a snapshot |
|---|---|---|
| Active placements (who works where, PERMANENT / TEMPORARY, trial/confirmed) | `placements`, web `/rm/placements`, `/rm/trials` | Two separate pages, no "today" status |
| Check-in / check-out with distance from home | `shift_logs`, web `/rm/checkins` | No idea of **late**: nothing records when a shift is meant to start |
| Attendance per day (PRESENT / ABSENT / LEAVE / HALF_DAY) | `staff_daily_attendance` | Leave is only marked on the day, never in advance |
| Care tasks (meds, vitals, activities), daily report, cook meal logs, rating, instructions | daily-care module, web `/rm/care` (RED/AMBER/GREEN) | Care/cook only, separate page |
| Who can take a new job | staff-request `candidates()` (S5, no PERMANENT placement…) | Only inside a request, not as a list |
| Client: today per staff | `GET /client/attendance/today`, `GET /client/dashboard` | Attendance only; work done is on separate care/cook screens |

So the snapshots are mainly **one query each that pulls these together**, plus two small additions: a shift start
time (for "late") and the availability rules.

---

## Definitions (shared by both snapshots)

### Staff availability (RM)
Each staff member in the RM's scope gets exactly one state for the chosen date:

| State | Rule |
|---|---|
| **Available** | Stage S5_DEPLOY, no active (TRIAL/CONFIRMED) placement, not on leave that day, no open HOLD |
| **Partly available** | Only on TEMPORARY (hourly) placements. They can take more hourly work, but not a PERMANENT job |
| **Deployed** | Has an active PERMANENT placement |
| **On leave / absent today** | Attendance for the day is LEAVE or ABSENT (whatever the placements) |
| **Free soon** | Deployed, but the placement ends (exit date or trial end without confirm) within 7 days |
| **In pipeline** | S2–S4 (not deployable yet), shown as a count with the stage split, not as rows |

Same rules as `candidates()`, so the snapshot and the request shortlist never disagree.

### Daily work alignment (both)
Per active placement, for the day:

| Signal | Source | Green / Amber / Red |
|---|---|---|
| Attendance | shift_logs | checked in on time = green · late > 15 min = amber · not checked in 60 min after start = red · ABSENT/LEAVE marked = red (RM) |
| Location | check-in distance | > 300 m from home = amber |
| Care tasks (UC/SC) | care_tasks today | due tasks done = green · any missed medicine = red · other missed = amber |
| Vitals | care_tasks out_of_range | any today = red |
| Cook | meal_logs vs today's menu slots | all due meals logged = green · a due meal not logged = amber · rating < 3 (7 d) = amber |
| Daily report (care) | daily_care_reports | not filled after 20:00 = amber |
| Instructions | client_instructions | refused, not decided = red (RM only) · unread > 2 h = amber |

The placement's overall status is the worst of its signals. The **existing `/rm/care/compliance` rules stay as they
are** and become one input to this.

---

## Phase 1 — Backend: shift start time (small migration)

"Late" needs to know when the shift starts. Nothing stores that today.

- `placements.shift_start` `VARCHAR(5)` (HH:MM, IST), nullable. Additive only.
- Filled automatically from the linked staff request's `start_time` (booking flow) when the placement is created.
- RM can set or change it in the placement form (web). Placements with no start time show attendance as
  "checked in / not yet" with **no late flag**. They are never shown as red for lateness.
- One-time backfill: copy `start_time` from linked requests into existing active placements.
- Script: `scratch/_snapshot_shift_start_migration.js` (re-runnable, additive).

## Phase 2 — Backend: `GET /rm/snapshot`

`GET /rm/snapshot?date=YYYY-MM-DD` (default today IST). Scope: RM = own staff and placements, BM = branch,
Admin = all, same as the other RM lists. `?series=UC|SC|CK` filters.

```json
{ "date": "2026-10-21",
  "summary": {
    "availability": { "available": 4, "partly_available": 2, "deployed": 18, "on_leave": 1, "free_soon": 3,
                      "in_pipeline": { "S2_VERIFY": 5, "S3_TRAIN": 2, "S4_AGREEMENTS": 1 } },
    "deployment": { "active": 20, "permanent": 18, "temporary": 2, "trial": 4, "trials_ending_7d": 2 },
    "alignment": { "GREEN": 14, "AMBER": 4, "RED": 2, "not_started": 3 } },
  "available": [ { "staff_id": "…", "name": "…", "series": "UC", "since": "2026-10-10", "language_tier": "T2",
                   "city": "…", "phone": "…" } ],
  "deployments": [ { "placement_id": "…", "staff": { "id": "…", "name": "…", "series": "SC" },
                     "client": { "id": "…", "name": "…", "city": "…" },
                     "type": "PERMANENT", "status": "CONFIRMED", "since": "2026-09-01", "trial_end": null,
                     "shift_start": "08:00",
                     "today": { "attendance": "LATE", "check_in": "08:24", "check_out": null, "far": false,
                                "care": { "done": 6, "total": 9, "missed": 1, "missed_meds": 0, "vital_alerts": 0 },
                                "cook": null, "report_filled": false },
                     "status_today": "AMBER", "flags": ["Checked in 24 min late", "1 task missed"] } ] }
```

- `deployments` is sorted RED → AMBER → not started → GREEN, so the problems are on top.
- Built with set-based queries (one per source table for all placements), not a loop of queries per placement.
  `/rm/care/compliance` today loops; the snapshot must stay fast with 300+ placements.

## Phase 3 — RM web: "Staff Snapshot" page

New page **`/rm/snapshot`**, first item in the RM sidebar (BM/Admin get the same page with their scope).

1. **Top strip: three blocks of counts.** Availability · Deployment · Today's alignment. Each count is a filter
   (click "Available 4" → the list below shows those four).
2. **Today's alignment table.** One row per active placement: staff, client, type, shift start, check-in
   (time + late/far badge), work progress (6/9 tasks, meals 2/3), status pill, flags. Row → existing
   placement / care detail pages. Date picker to look at a past day.
3. **Available staff.** Cards or rows with series, language tier, city, available since, plus a button
   **"Shortlist for a request"** that opens the open requests of that series.
4. **Free soon.** Placements ending or trials ending in 7 days.

Refresh every 60 s. Existing pages (Check-ins Map, Daily Care, Active Placements) stay and the rows link to them.

## Phase 4 — Backend: `GET /client/snapshot` (for the app)

One call for the client app's home. Scope: the logged-in client's active placements.

```json
{ "date": "2026-10-21",
  "staff": [ {
      "placement_id": "…",
      "staff": { "id": "…", "first_name": "Rekha", "series": "UC", "series_label": "Caretaker", "photo_url": "…" },
      "deployment": { "type": "PERMANENT", "status": "TRIAL", "since": "2026-10-15", "trial_ends": "2026-10-22",
                      "shift_start": "08:00", "shift_hours": 12 },
      "today": { "attendance": "PRESENT", "check_in": "08:05", "check_out": null, "on_time": true,
                 "work": { "done": 6, "total": 9, "next": "Evening medicine at 18:00" },
                 "meals": null, "report_filled": false, "unread_instructions": 0 },
      "status_today": "GREEN",
      "message": "Rekha checked in at 08:05 · 6 of 9 tasks done",
      "last_7_days": [ { "date": "2026-10-15", "attendance": "PRESENT" }, … ] } ],
  "requests": [ { "id": "…", "request_no": "SR-2026-0041", "series": "CK", "status": "SHORTLISTED" } ] }
```

- No staff phone/Aadhaar/address beyond what `/client/staff/:id/profile` already allows.
- `message` is a one-line plain-English summary the app can show as is.
- **What the client sees as "availability":** not the staff pool (that is internal). Only their open requests
  and their status, and whether a replacement is in progress.
- A client with no active placement gets `staff: []` and their requests, so the home can show "Request staff".

## Phase 5 — Client app (mobile dev, brief)

Brief `docs/MOBILE_BRIEF_STAFF_SNAPSHOT.md`, one section per screen:
- **Home:** "Today at home" cards from `/client/snapshot`, one per staff. Status colour, check-in time, progress
  bar for tasks/meals, the `message` line. Tap opens the existing care/cook day screen.
- **7-day strip** under each card (present / absent / leave dots).
- **Trial banner** when `trial_ends` is within 3 days ("Confirm or ask for a change").
- Pull-to-refresh; poll every 2 min while the home is open.

## Tests

`npm run test:snapshot`: live HTTP checks for availability states (one fixture per state), late / not-started /
far / missed-med / cook-meal rules, RM vs BM vs Admin scope, client sees only their own placements, nothing
private leaks, and the date parameter. Same fixture/cleanup style as `test:registration`.

## Order and size

| Phase | What | Size |
|---|---|---|
| 1 | shift_start migration + backfill + placement form field | small |
| 2 | `GET /rm/snapshot` | medium |
| 3 | RM web page | medium |
| 4 | `GET /client/snapshot` | small–medium |
| 5 | Mobile brief | small |

Deploy like 10: migration first, then backend, then the prebuilt frontend.

## Decisions needed from you

1. **Shift start time for "late":** add `shift_start` to placements (auto from the booking, RM can edit)? Without
   it we can only say "checked in / not yet", not "late". *Recommended: yes.*
2. **Late threshold:** 15 min = amber, not in by 60 min = red? *Recommended: yes, as above.*
3. **Planned leave:** today leave is only marked on the day. Should staff/RM be able to mark leave **in advance**
   (so "available" and "free soon" are right for next week)? *Recommended: later, as a separate small piece.*
4. **RM page:** a new "Staff Snapshot" page at the top of the sidebar, or should it replace the current
   "RM Dashboard"? *Recommended: new page; keep the dashboard.*
5. **Client "availability":** only their requests + replacement status (as above), or do they need anything
   else, e.g. "a backup caretaker is available if yours is absent"?

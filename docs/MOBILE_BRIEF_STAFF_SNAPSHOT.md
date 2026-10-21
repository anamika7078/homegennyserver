# Mobile App Brief — "Today at Home" Snapshot (Client)

**21 Oct 2026 · For the Flutter app (checked against `homegennyapp` main @ `fc9f9d3`).**

The client asked for a snapshot to track **staff availability, current deployment and daily work status**. The RM
gets it on the web (done). The client gets it in the app, as the top of the home screen. This brief is for that.

The backend is built and tested against live API calls (`npm run test:snapshot`, 41 checks).

**Common rules (same as the other briefs)**
- Base URL `/api/v1`. A successful response is `{ success: true, data }`.
- An error looks like `{ "statusCode": 400, "message": { "message": "<readable text>" } }`. Show `message.message` as it is.
- All app text is English.

## What changes, and on which screen

| What changes | App screen | Section |
|---|---|---|
| One call, `GET /client/snapshot`, gives everything for "today at home" | Client home | §1 |
| A **"Today at home"** card per staff member: status colour, check-in, tasks/meals progress, one-line message | Client home (replaces `_StaffRowCard`'s data) | §2 |
| A **7-day attendance strip** under each card | Client home | §3 |
| **Trial ending** banner on the card | Client home | §4 |
| **Requests and replacements in progress** (the client's "availability") come from the same call | Client home, "Needs your attention" | §5 |

Nothing is removed. `GET /client/dashboard` (invoices, header numbers) and `GET /client/attendance/today` keep
working. The home can call `/client/snapshot` **in addition** to the dashboard.

---

## 1. `GET /client/snapshot` (CLIENT)

Optional `?date=YYYY-MM-DD` (IST). Default is today. The home always uses today; `date` is only for testing.

```json
{
  "date": "2026-10-21",
  "generated_at": "2026-10-21T04:12:09.512Z",
  "staff": [
    {
      "placement_id": "43c0…",
      "staff": {
        "id": "c339…",
        "first_name": "Rekha",
        "series": "UC",
        "series_label": "Caretaker",
        "photo_url": "/client/staff/c339…/photo",
        "profile_url": "/client/staff/c339…/profile"
      },
      "deployment": {
        "type": "PERMANENT",
        "visit": "REGULAR",
        "status": "TRIAL",
        "since": "2026-10-15",
        "trial_ends": "2026-10-22",
        "shift_start": "08:00",
        "shift_hours": 12
      },
      "today": {
        "attendance": "LATE",
        "check_in": "08:30",
        "check_out": null,
        "late_by_min": 30,
        "work": { "done": 6, "total": 9, "missed": 0, "next": "Evening medicine at 18:00" },
        "meals": null,
        "report_filled": false,
        "unread_instructions": 0
      },
      "status_today": "AMBER",
      "message": "Rekha checked in at 08:30 (30 min late) · 6 of 9 tasks done",
      "last_7_days": [
        { "date": "2026-10-15", "attendance": "PRESENT" },
        { "date": "2026-10-16", "attendance": "PRESENT" },
        { "date": "2026-10-17", "attendance": "LEAVE" },
        { "date": "2026-10-18", "attendance": "PRESENT" },
        { "date": "2026-10-19", "attendance": "NONE" },
        { "date": "2026-10-20", "attendance": "PRESENT" },
        { "date": "2026-10-21", "attendance": "PRESENT" }
      ]
    }
  ],
  "requests": [
    { "id": "…", "request_no": "SR-2026-0041", "series": "CK", "status": "SHORTLISTED",
      "visit_type": "REGULAR", "start_date": "2026-10-25", "start_time": "08:00", "created_at": "…" }
  ],
  "replacements": [
    { "id": "…", "placement_id": "…", "status": "UNDER_RM_REVIEW", "created_at": "…" }
  ]
}
```

**Field notes**
- `staff[]` has one entry per staff member **currently placed** with this client (trial or confirmed), oldest
  first. Empty array → show the existing "Request staff" prompt.
- `photo_url` returns 404 when no photo is on file. Show initials then, as the staff profile screen already does.
- `today.work` is set only for caretakers (UC/SC), `today.meals` only for cooks (CK). Both can be `null`.
- `meals`: `{ planned, logged, due, not_logged: ["BREAKFAST"] }`. `due` = meals whose time has passed.
- `today.work.next` is the next task still to do, or `null` when nothing is left.
- No staff phone, Aadhaar or address in this response. The phone stays on the staff profile screen.

**`today.attendance` values**

| Value | Meaning | Show |
|---|---|---|
| `ON_TIME` | Checked in within 15 min of `shift_start` | "In at 08:05" (green) |
| `LATE` | Checked in more than 15 min late | "In at 08:30 · 30 min late" (amber) |
| `CHECKED_IN` | Checked in, no shift start set | "In at 08:05" |
| `NOT_STARTED` | Shift not due yet, or not a working day for a one-time visit | "Due at 08:00" or "Not in yet" (grey) |
| `NOT_IN_YET` | 15–60 min past the start, no check-in | "Not in yet · due 08:00" (amber) |
| `NO_SHOW` | 60+ min past the start, no check-in | "Not checked in today" (red) |
| `ABSENT` / `ON_LEAVE` | Marked absent / on leave by the RM | "Absent today" / "On leave today" (red) |

**`status_today`**: `GREEN` (on track) · `AMBER` (keep an eye) · `RED` (needs attention) · `NOT_STARTED` (grey).
It is the worst of attendance, missed tasks (a missed medicine or an out-of-range reading is red), meals not logged
and the daily report. Use it for the card's colour dot or left border.

`message` is a ready-to-show line. Use it as is; don't rebuild it from the fields.

## 2. "Today at home" cards

Put them at the top of the client home, above "Needs your attention", replacing what `_StaffRowCard` shows today.

```
┌────────────────────────────────────────────────┐
│ ● [photo] Rekha · Caretaker        Trial · ends 22 Oct │
│   Rekha checked in at 08:30 (30 min late) · 6 of 9 tasks done │
│   ▓▓▓▓▓▓░░░  6/9 tasks   Next: Evening medicine at 18:00 │
│   M T W T F S S   ● ● ○ ● · ● ●                         │
│   [ Today's care ]                                     │
└────────────────────────────────────────────────┘
```

- Dot colour from `status_today`.
- Progress bar: `work.done / work.total` (caretaker) or `meals.logged / meals.planned` (cook). Hide it when the
  total is 0.
- **Tap the card** → the existing screens: caretaker → today's care (`/care/placements/:pid/day`), cook → today's
  meals. The staff photo/name → the staff profile.
- More than one staff member → one card each, in the order given.
- Pull-to-refresh, and refresh every 2 minutes while the home is visible.

## 3. 7-day strip

`last_7_days` is oldest first and ends with `date`. One dot per day:

| `attendance` | Dot |
|---|---|
| `PRESENT` | filled green |
| `ABSENT` | filled red |
| `LEAVE` | filled amber |
| `NONE` | hollow grey (nothing recorded, e.g. a weekly off) |

Day letters from the date (M T W …). Tapping the strip opens the existing attendance history screen.

## 4. Trial banner

When `deployment.status == "TRIAL"` and `trial_ends` is today or within 3 days, show a slim banner on the card:

> **Trial ends on 22 Oct.** Happy with Rekha? Your RM will confirm the placement. Want a change? *Request replacement*

"Request replacement" uses the existing replacement flow (`POST /client/replacements`).

## 5. Requests and replacements

The client doesn't see the staff pool. "Availability" for them means: **what they asked for, and where it is.**

- `requests[]`: open staff requests (`NEW`, `ASSIGNED`, `SHORTLISTED`, `CLIENT_SELECTED`). The home's
  "Needs your attention" section already lists open requests from `GET /client/staff-requests`. You can keep it, or
  read `requests[]` from this call instead. `SHORTLISTED` needs the client to choose, so keep it highlighted.
- `replacements[]`: replacement requests the RM is still looking at. Show one line per item on that staff member's
  card: "Replacement requested · RM reviewing".

## 6. Test checklist

Use the dev server. The RM web **Staff Snapshot** page shows the same day from the RM's side, which helps.

1. Client with a caretaker who checked in on time → green card, "checked in at …", tasks progress.
2. RM sets the placement's **shift start** (web → Active Placements → open the card → "Shift starts at"). Check in
   20 min after it → amber "30 min late"-style line.
3. No check-in an hour after the shift start → red "not checked in today".
4. Cook → "x of y meals made"; a meal not logged an hour after its time → amber.
5. RM marks leave for today → red "on leave today", amber dot in the strip.
6. Trial ending in 2 days → banner.
7. No staff placed → "Request staff" prompt; an open request shows under "Needs your attention".

# Mobile app change needed — staff check-in is now instantly billable

## What changed on the backend (already live)

`POST /staff/attendance/check-in` (`staff-mobile.controller.ts`):

- The `ShiftLog` row is now created/updated with `status: 'APPROVED'`
  immediately (was left at the default `PENDING`, waiting on RM review).
- It's also immediately synced into `StaffDailyAttendance` (status
  `PRESENT`) in the same request — the exact same sync `PATCH
  /rm/shifts/:id/review`'s APPROVED branch already did, just triggered at
  check-in time instead of at RM-approval time.
- **Response shape is unchanged** — still `{ success, attendanceId, status:
  "CHECKED_IN", latitude, longitude, timestamp }`. No new fields to handle.

`PATCH /rm/shifts/:id/review` is unchanged and still works exactly as
before — RM can still REJECT (or FLAG) a shift after the fact if it looks
fraudulent or wrong. A REJECTED shift un-syncs the day from
`StaffDailyAttendance` (already-existing behavior), and — per the separate
attendance-fallback change — RM can then directly correct that date via
`PUT /rm/attendance`.

Also new: a monthly cron (`EnterpriseCronService.autoGenerateAttendanceInvoices`,
runs `EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT`) now automatically generates the
invoice/payroll for every CONFIRMED placement's previous month, using the
exact same `PayrollService.runAttendancePayroll()` RM's manual "Generate
Invoice" button already called. RM's manual button and Finance's manual
generate endpoint both still exist and still work — this doesn't replace
them, it just means nobody has to remember to click it every month.

## Why

Attendance is the staff's own record — RM's role is reviewing it after the
fact (catching fraud/errors), not gatekeeping it before it counts. Requiring
RM approval before a check-in became billable meant a staff member's
attendance didn't count toward payroll until RM happened to open the Shifts
screen and approve it, which could lag days behind reality.

## What needs to change in the Flutter app

### Staff-side check-in screen
- If there's any "pending RM approval" / "awaiting review" copy shown after
  check-in, remove it — attendance now counts immediately. A simple
  "Checked in ✓" confirmation is accurate now.
- Nothing about the request/response contract changed, so this is copy-only.

### RM-side shifts screen (`rm_tasks_screen.dart`)
- Shifts will now often already show as APPROVED when RM opens this screen
  (rather than a queue of PENDING items waiting on them) — the screen still
  works exactly as before (GET/PATCH `/rm/shifts`), but its purpose shifts
  from "approve today's work" to "spot-check and correct if something looks
  wrong." Framing/copy update only, no functional change required.

### RM-side attendance grid (`rm_attendance_screen.dart`)
No further change beyond what's already documented in
`MOBILE_BRIEF_ATTENDANCE_STAFF_OWNED.md` — the fallback-only gate on
`PUT /rm/attendance` already accounts for shifts being auto-approved (a
same-day direct-mark attempt will now correctly get blocked immediately
after check-in, not just after a later RM approval).

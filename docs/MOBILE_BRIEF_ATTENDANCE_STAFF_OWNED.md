# Mobile app change needed — attendance is staff-owned, RM's direct-mark is fallback-only

## What changed on the backend (already live)

`PUT /rm/attendance` (`rm.controller.ts` + `rm.service.ts`'s `markAttendance()`)
now checks whether the staff already has a `ShiftLog` (their own
check-in/check-out, via `POST /staff/attendance/check-in`) for that date:

- **No shift log at all**, or **one RM already REJECTED** → direct marking
  still works exactly as before. This is the genuine fallback case (staff
  has no app access that day, or RM is correcting a rejected/bad entry).
- **A PENDING, APPROVED, or FLAGGED shift log exists** → `PUT /rm/attendance`
  now returns 400 instead of silently overwriting it:
  ```
  400 { "message": "Staff already has a <pending|approved|flagged>
  self-check-in for this date — review it via PATCH /rm/shifts/:id/review
  instead of marking attendance directly. Direct marking is only for dates
  with no shift log, or one you've already rejected." }
  ```

Nothing else changed — `POST /staff/attendance/check-in`/`check-out`,
`GET/PATCH /rm/shifts/:id/review`, and the attendance→invoice-preview flow
are all unchanged.

## Why

Attendance should be the staff's own record (self-check-in with GPS), not
something RM types into a grid on their behalf — RM's real role is
reviewing/approving what the staff submitted (`PATCH /rm/shifts/:id/review`),
not creating the record itself. `PUT /rm/attendance` stays available, but
only as a correction tool for genuine gaps — not as an everyday substitute
for the staff checking in.

## What needs to change in the Flutter app

### `rm_attendance_screen.dart`
- The existing error handling (`result.fold(... onError: SnackBar(f.message))`)
  already surfaces the new 400 message correctly — no crash, nothing to fix
  there mechanically.
- But RM will now hit this regularly for any staff who self-check-in, so the
  screen's framing needs to change: it's no longer "the way RM marks daily
  attendance," it's a fallback for staff without a shift log. Consider:
  - A visual distinction between dates with an existing shift log (locked,
    "reviewed via Shifts" with a link/button to `rm_tasks_screen.dart`'s
    shift-review flow) vs. genuinely empty dates (still directly editable
    here).
  - Or just let the 400 SnackBar do the job and rely on RM learning to use
    Shifts review first — simplest, but a worse UX than graying out
    already-covered dates.

### `rm_tasks_screen.dart` (shift-log review)
No functional change needed — this is already the correct, unaffected path
(`GET/PATCH /rm/shifts`). Worth surfacing more prominently now that it's
meant to be RM's primary daily-attendance touchpoint, not a secondary tab.

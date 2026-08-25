# Mobile app change needed — Placement moves from S4 to S5_DEPLOY

## What changed on the backend (already live)

`POST /placements` (`homegennyserver/src/modules/placement/placement.controller.ts` +
`placement.service.ts`):

1. **New hard stage gate.** The staff must already be at `pipeline_stage ===
   'S5_DEPLOY'`. Any other stage now returns:
   ```
   400 { "message": "Placement can only be created once the staff has reached
   S5_DEPLOY (current stage: <STAGE>)." }
   ```
   Previously there was no stage check at all — the app could (and did) call
   this from S4_AGREEMENTS.

2. **New optional `status` field** in the create body: `"TRIAL"` (default,
   unchanged behavior) or `"CONFIRMED"` (skips the trial entirely and creates
   the placement already confirmed). If `"CONFIRMED"` is sent, `staff_salary`
   and `management_fee` are now **required in the same request** — either
   directly, or computed from `wage_config` (point 4 below) — 400 if
   neither is supplied:
   ```
   400 { "message": "staff_salary and management_fee (directly, or computed
   via wage_config) are required to create a placement directly as
   CONFIRMED." }
   ```

3. **`POST /:id/confirm` (the separate TRIAL→CONFIRMED step) now also
   requires A2 and A3 to be on file for that placement** — an SOW with
   status SENT or ACKNOWLEDGED (not DRAFT), and at least one Indemnity row.
   400 otherwise, naming whichever is missing:
   ```
   400 { "message": "Cannot confirm — A2 (Scope of Work) sent and A3
   (Client Indemnity) sent required first." }
   ```
   (or just whichever one of the two is still missing). **This check does
   NOT apply to a placement created directly as `status: "CONFIRMED"`** in
   point 2 above — at that instant the placement doesn't exist yet either,
   so A2/A3 can't possibly exist yet; "Confirm Now" is a deliberate
   fast-path exception, not a bug. Handle this 400 in the placement-detail
   screen's confirm action (wherever `POST /:id/confirm` is currently
   called) with a clear message pointing the RM at the missing A2/A3.

4. **`POST /placements` and `PATCH /:id/terms` now accept a `wage_config`
   object** instead of (or as well as) flat `staff_salary`/`management_fee` —
   the same fields/formula as Finance's Commercial Calculator
   (`basic_wage, da, hra, skilled_allowance, working_hours, employer_pf_pct,
   employer_pf_max, employee_pf_pct, employer_esic_pct, employee_esic_pct,
   bonus_pct, bonus_frequency, leave_days, lwf_amount, uniform_allowance,
   relieving_pct, management_pct, professional_tax`, plus the
   `..._applicable` boolean toggles and `gst_applicable/gst_type/gst_pct`).
   When `wage_config` is supplied, `staff_salary` is set from the computed
   `netSalary` and `management_fee` from the computed `managementFee` —
   any flat `staff_salary`/`management_fee` also sent in the same request is
   ignored. The full computed breakdown is returned on the placement as
   `wage_breakup`, and the raw inputs as `wage_config` (both persisted, so
   they round-trip on every subsequent `GET`/`PATCH` too).
   New endpoint **`POST /placements/calculate-wage`** takes the same
   `wage_config` shape and returns the breakdown with nothing persisted —
   use it to drive a live preview as the RM fills the form, exactly like
   Finance's "Live Preview" toggle, before the RM actually submits
   create()/updateTerms(). RM already has access to all of this (no new
   role/permission needed).

Nothing else changed — `POST /:id/confirm`, `POST /:id/exit`, `GET
/placements` are all unchanged. `POST /sow` and `POST /indemnity` are also
unchanged (still require an existing `placement_id`) — see "Why" below for
how that's meant to be sequenced now.

## Why (business reason)

A candidate's S4_AGREEMENTS step should only require **A1 (Employment
Agreement)** — that's staff-level, no client/placement needed. A2 (Scope of
Work) and A3 (Client Indemnity) are inherently **client-specific** documents,
and a staff can end up placed with more than one client over time — so it
never made sense for them to be gated behind a throwaway placement created
mid-S4 just to get a `placement_id`. The new sequencing:

- **S4_AGREEMENTS**: sign A1 only → advance to S5_DEPLOY. (The backend's
  existing deployment-eligibility gate already only checks "a signed
  agreement exists" — this was already true, nothing changed there.)
- **S5_DEPLOY**: RM picks a client and creates the placement — choosing
  TRIAL or CONFIRMED — then creates A2/A3 against *that* placement.

## What needs to change in the Flutter app

### 1. `rm_stage4_hub_screen.dart`
- Remove the **"Placement (TRIAL)"** step from `_StepsListContent` (and the
  `placement`/`placementAsync` plumbing that only existed to feed it).
- Remove the **A2** and **A3** tiles from this screen entirely — they no
  longer belong in S4 (they can't be created without a placement, and
  placement no longer exists yet at this point).
- Change the `allDone` condition (currently `a1Signed && placement != null
  && sowSent && indemnitySent`) to **just `a1Signed`**.
- Update the `AdvanceStageButton`'s `enabled:` to `a1Signed` and drop the
  "A1 must be signed, the placement created, and A2/A3 sent..." helper text
  to something like "Sign A1 to advance to Deploy (S5)."
- The client-selector card can stay (A1 still needs a client context via
  `agreementClientProvider`), but its copy ("A1, the placement, A2, and A3
  are all tied to this client") should drop the placement/A2/A3 mention.

### 2. New S5 Deploy hub (doesn't exist yet — needs building)
Once a staff is at S5_DEPLOY, they need a screen with the same shape as the
old S4 `_StepsListContent` but for: **Placement → A2 (SOW) → A3
(Indemnity)**. Suggested reuse: this can be a new `RmStage5DeployHubScreen`
that mirrors the existing `_InstrumentList`/`_StepsListContent` pattern —
placement tile unlocked immediately (staff is already S5), A2/A3 tiles
unlock once `placementId` exists, exactly like the old A2/A3 gating logic
already in `rm_stage4_hub_screen.dart` (that logic is correct, it's just
moving screens). Whether the client for the S5 placement defaults to the
same client A1 was signed against, or is picked fresh, is a UX call — either
is fine with the backend (it takes whatever `client_id` you send).

### 3. `rm_placement_create_screen.dart`
- `_stageAllowsPlacement` currently returns true for `S4_AGREEMENTS ||
  S5_DEPLOY` — change to **`S5_DEPLOY` only**.
- Update the header comment block (lines 13-21) — it currently documents
  the old "backend enforces nothing, always TRIAL" behavior, which is now
  false on both counts.
- Add a **Trial vs. Confirm Now** choice to the form (e.g. a segmented
  control or two buttons). When "Confirm Now" is selected:
  - Require the salary + fee fields — or, once section 5 below is also
    built, the whole wage-breakup form — to be completed before enabling
    submit (currently optional in the UI).
  - Send `"status": "CONFIRMED"` in the body.
  - Skip/hide the "Trial dates default to..." helper text and the amber
    "This creates a TRIAL placement..." banner — replace with something
    reflecting the chosen mode.
  - On success, still navigate to `placementDetail` — it'll just already
    show CONFIRMED status instead of TRIAL.
- Handle the new 400 message from the stage gate the same way the existing
  client-side check already does (should be effectively unreachable now
  that this screen is only reachable from S5, but keep it as a safety net
  for a stale cached staff object).

### 4. Anywhere else that navigates to `RmRoutes.placementCreate(staffId)`
Search for other callers (the S4 hub was the only one referenced in the
code read so far) and make sure none of them still route here from S4.

### 5. `rm_placement_create_screen.dart` — replace the salary/fee fields with a wage-breakup form
Instead of the two bare `staff_salary`/`management_fee` text fields, RM now
fills the full Commercial Calculator-style form — same fields as
`WageConfigFormModal` in the web app (`homegenny/src/components/finance/WageConfigFormModal.tsx`,
mode `customer_assignment`, minus the unit-code/customer-multi-resource
section, which doesn't apply here): Basic Wage, DA, HRA, Skilled Allowance,
working hours (8/12), PF/ESIC/Bonus/LWF/Uniform/Relieving toggles + %s,
Management Fee %, Professional Tax, GST config. Reasonable statutory
defaults (mirroring `WageConfigFormModal`'s `DEFAULT_FORM_DATA`): Employer
PF 13%, PF ceiling ₹15,000, Employee PF 12%, Employer ESIC 3.25%, Employee
ESIC 0.75%, Bonus 8.33% monthly, Leave days 32, LWF ₹62, Uniform ₹275,
Relieving 16.67%, GST 18% intra-state — RM edits Basic/DA/HRA/Skilled/
Management% per the actual deal, the statutory %s rarely need changing.

- On every field change, call `POST /placements/calculate-wage` (debounced)
  to show a live preview (staff take-home / management fee / CTC), same
  idea as the web calculator's "Live Preview" panel.
- On submit, send the whole form as `wage_config` in the `POST /placements`
  (or `PATCH /:id/terms`) body — don't compute netSalary/managementFee on
  the client and send those directly; the backend derives and stores them.
  This also applies to the "Trial vs. Confirm Now" choice in Flutter section
  3 above — `wage_config` satisfies the CONFIRMED-requires-salary/fee check
  the same way flat `staff_salary`/`management_fee` did.
- A flat manual-entry fallback (just typing salary + fee, no breakdown) can
  stay as an option if useful, by sending `staff_salary`/`management_fee`
  directly instead of `wage_config` — the backend still accepts both.

### 6. Follow-up (already fixed, no mobile action required): monthly payroll now honors these rates
Previously, the PF/ESIC/GST *percentages* RM configured here were computed
correctly at placement time but then silently ignored by the monthly
attendance-based payroll/invoice run (`PayrollService`), which always
recalculated using fixed statutory defaults (13%/12% PF, 0.75%/3.25% ESIC,
18% GST) regardless of what was actually agreed. This is now fixed
server-side — `previewAttendancePayroll`/`runAttendancePayroll` read the
placement's stored `wage_config` and use those rates; placements without a
`wage_config` (flat entry) still use the statutory defaults, unchanged.
Every `calculation` response (invoice preview, invoice generate) now also
includes a `ratesUsed: { pfEmployeePct, pfEmployerPct, pfCeiling,
esicEmployeePct, esicEmployerPct, gstPct }` block — `rm_invoice_preview_screen.dart`
doesn't currently hardcode any rate in its labels (just shows amounts), so
there's nothing broken to fix, but it could optionally show the rate next
to each line (e.g. "PF (Employee contribution, 10%)") using this new field
if useful — not required.

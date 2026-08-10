# Phase 3 Implementation Report — Core Business Logic & Workflow Correctness

Scope: finance calculation correctness, series enum unification, scenario routing
integration, restricted-list enforcement, and deployment eligibility gates. Two
items were investigated and explicitly **not** auto-resolved per instruction —
historical financial records and the PF ambiguity — see §A and the file-header
comment in `statutory-calc.util.ts`. Everything else below was implemented and
verified live. Phase 1 and Phase 2 re-verified intact at the end (§G).

One thing surfaced mid-implementation that wasn't in the original audit: closing
the deployment gates only matters if there's no way around the FSM entirely.
There was — `PATCH /staff/:id` let BM/Admin set `pipeline_stage` directly,
skipping every check this phase adds. That's fixed too (§D).

---

## A. Finance

**GST — the critical fix.** `commercial.service.ts:310` computed
`gst = monthlyCost * (gstPct/100)` — the entire quoted cost, not the management
fee. Verified against the real stored record from the audit:

| | Before | After |
|---|---|---|
| Management fee | ₹12,069.70 (unchanged) | ₹12,069.70 |
| **Stored/Actual GST** | **₹42,213.55** | **₹2,172.55** |
| Formula | `monthlyCost × 18%` | `managementFee × 18%` |

Verified live through the actual HTTP endpoint (`POST /finance/commercial/calculations/calculate`), not just the unit function — a fresh calculation returned `management_fee: 1139.38`, `gst: 205.09` (exactly 18% of the fee), against a `monthly_cost` of `218,553.23` that the old formula would have taxed directly.

**ESIC threshold.** Was gated only by a config boolean, no statutory `≤ ₹21,000` check at all. Fixed and verified at the exact boundary:

| Gross | Expected | Actual |
|---|---|---|
| ₹20,999 | ESIC applies | ✅ applicable=true, employee=₹157.49 |
| ₹21,000 | ESIC applies | ✅ applicable=true, employee=₹157.50 |
| ₹21,001 | ESIC does not apply | ✅ applicable=false, employee=₹0 |

The wage-config `esic_applicable` toggle is kept as an *additional* AND-condition (a category can still be turned off for other reasons) but can no longer switch ESIC on above the statutory limit.

**Net salary.** `netSalary = gross − employeePf − employeeEsic − professionalTax` → professional tax dropped (spec has no such term; audit §D5). `professionalTax` is still computed and returned as its own field for display — just no longer folded into net.

**Client Total** — unchanged formula, now correct because `gst` and `managementFee` feeding into it are correct: `gross + employerEsic + employerPf + managementFee + gst`.

### Architecture — one calculation source, not five

New: [`src/common/finance/statutory-calc.util.ts`](src/common/finance/statutory-calc.util.ts) — `calculateGstOnFee`, `calculateEsic`, `calculatePfFlat`, `calculateNetSalary`, `calculateClientTotal`. This is the audit-confirmed baseline extracted from `payroll.service.ts`, not a new invention.

| Service | Change |
|---|---|
| `payroll.service.ts` | Refactored to delegate to the shared util — same numbers, now sourced from one place instead of holding its own copy. |
| `commercial.service.ts` | GST/ESIC-threshold/net-salary now use the shared util (§ above). PF left structurally as-is — see ambiguity note below. |
| `enterprise-payroll.service.ts` | ESIC line switched to the shared util (was already numerically correct — this just removes the duplicate constant). |
| `esic.service.ts` | No change — it's a report/export layer over already-computed `payroll_records`, doesn't independently calculate anything. |
| `invoice.service.ts` | No change — confirmed read-only formatting of already-stored values, not a calculation engine. |

### PF — ambiguity flagged, not resolved (per instruction)

The spec's PF rule is genuinely ambiguous (cap vs. cliff — see original audit). `calculatePfFlat()` preserves `payroll.service.ts`'s confirmed baseline (`min(gross,15000) × 12%`, same base both sides) and is now the one place that logic lives.

`commercial.service.ts`'s PF was **not** forced onto that baseline — it computes PF on a different base entirely (`basic + skilled allowance + leave`, capped at a *per-wage-config-row configurable* `employer_pf_max`, potentially varying by category/state/zone). That's not obviously the same ambiguity as "cap vs cliff" — it may be intentional flexibility for a quotation tool pricing different labor categories across regions. Forcing it onto the flat statutory formula would be inventing a resolution, which the instruction explicitly said not to do.

**BUSINESS DECISION REQUIRED:** should the commercial quotation calculator's PF also be constrained to the flat statutory rule (`min(gross,15000) × 12%`), or is the per-category/state configurable ceiling intentional? Both `payroll.service.ts`'s reading and `commercial.service.ts`'s structure are documented in code comments at each site for whoever makes this call.

### Historical financial records (investigated, not modified)

| Table | Status breakdown | Affected by GST bug |
|---|---|---|
| `finance_commercial_calculations` | 2 APPROVED, 2 DRAFT | Yes — 4 items total |
| `finance_quotations` | 4, **all DRAFT** | Yes — same 4 underlying items |
| `finance_rate_cards` | 2 (derived from the APPROVED calcs) | No — stores cost rates only, GST isn't a rate-card field |
| `client_invoices` (real EOR payroll invoices) | 1 PAID, 2 PENDING, 1 APPROVED | **No** — these went through `payroll.service.ts`, already spec-correct |

**The good news:** nothing that was ever sent to a client or paid carries the bug. All 4 affected commercial-calculator records are either DRAFT or internally-APPROVED-but-not-yet-quoted-to-a-client — no external party has seen the wrong numbers. Total inflated GST across the 4 affected items: **₹133,456.72** (itemized in the investigation query, available on request), none of it billed.

Per instruction, I did **not** recalculate or overwrite these records. Since none were externally distributed, my recommendation is that they're safe to simply re-run through the fixed calculator (not "corrected" in place — regenerated) — but that's a decision for you to make and execute, not something I did unilaterally.

---

## B. Series Enum Unification

Root cause confirmed exactly as the audit described: `pipeline-fsm.service.ts`'s `routeScenario()` and `video-cert.service.ts`'s `getPrompts()` both switched/keyed on the short form (`SC`/`UC`/`DR`/`MAID`) with no normalization, while `StaffApplicant.series` stores the Prisma enum (`SKILLED_CARE`/`UNSKILLED_CARE`/`DRIVER`/`MAID`).

The canonical mapping layer **already existed** — `src/common/mappers/staff.mapper.ts`'s `mapSeriesFromShort`/`mapSeriesToShort`, already used correctly by `staff.service.ts`. It just wasn't applied at the other two call sites. Fixed by normalizing through the same mapper at the top of both functions — no new vocabulary invented, no database values touched.

**Verified live, both vocabularies, all 4 series:**

| Series | Short form | DB form | Prompts |
|---|---|---|---|
| Maid | `MAID` | `MAID` | 9 / 9 |
| Skilled Caretaker | `SC` | `SKILLED_CARE` | 10 / 10 |
| Unskilled Caretaker | `UC` | `UNSKILLED_CARE` | 10 / 10 |
| Driver | `DR` | `DRIVER` | 12 / 12 |

No series returns 0 prompts under either vocabulary anymore.

---

## C. Scenario Routing — Connected to the Workflow

`routeScenario()` was a standalone advisory endpoint (`POST /pipeline/:staffId/route`) that `advanceStage()` never called — `current_scenario` and `pipeline_events.scenario_code` stayed `NULL` regardless of what happened.

**Scoped to the S4_AGREEMENTS → S5_DEPLOY transition** — the one transition the spec's own scenario decision tree is written around (restricted-list, PV, video, medical, DR-specific flags), and the one the audit's own example centers on. Not every transition needs a scenario code (S1→S2 etc. don't have a documented decision tree to route against), so I didn't invent routing for those.

At the deploy decision, the same flags gathered for the deployment gate (§E) feed `routeScenario()`, and the result is persisted to all three places the spec implies it should land:

**Verified live** (real SC applicant, full positive deployment path):
```
staff_applicants.current_scenario   = "SC-01"
pipeline_events.scenario_code       = "SC-01"   (on the S5_DEPLOY row)
scenario_logs                       = { scenario_code: "SC-01", triggered_by: <RM user id>,
                                          flags: {...}, pipeline_stage: "S5_DEPLOY" }
```

The gate's ALLOW/DENY decision is never derived from parsing the scenario code string — it comes from the explicit checks in §E. The scenario code is a parallel, documented "why," not the control itself. If the gate blocks, the whole transaction rolls back (§E), so no scenario code is persisted for a blocked attempt either — nothing false gets recorded.

---

## D. FSM — Business Gates on Top of Existing Validity Checks

**Bypass found and closed first.** `staff.controller.ts`'s `PATCH /staff/:id` only blocked `pipeline_stage` mutation for role `RM` specifically (`if (req.user.role === 'RM' && body.pipeline_stage)`). Since Phase 1 gated this controller to `RM, BM, ADMIN`, that left **BM and Admin able to set `pipeline_stage` directly**, skipping FSM transition validity *and* every gate this phase adds. Fixed to block `pipeline_stage`, `current_scenario_code`, and `terminal_outcome` from all roles — these are now FSM-owned fields, only settable via `POST /pipeline/:staffId/advance`.

**Architecture is now:**
```
Auth → Authorization → FSM transition validity → Restricted-list check →
  Business/deployment gates (S5_DEPLOY only) → Scenario routing → 
  DB transaction (stage + event + scenario, or nothing at all) 
```
`VALID_TRANSITIONS`, `actor_id`-from-JWT, and `FOR UPDATE` locking are all untouched from Phase 1's verified-correct implementation.

**Restricted list — now actually blocks, not just advisory.**
- **Intake**: `staff.service.ts.create()` checks phone (and aadhaar if supplied) before creating the record at all. Verified live: creating a staff applicant with a phone already on the restricted list returns `403` with the reason, before any row is written.
- **Progression**: re-checked at the top of every `advanceStage()` call (not just intake), so a match added *after* intake still blocks further movement. Verified live: an applicant clean at intake, advanced to S2_VERIFY, then retroactively added to the restricted list by BM — the next advance attempt (S2→S3) is blocked with the reason; only a move to **TERMINAL** is still permitted (so a restricted applicant isn't permanently stuck mid-pipeline with no way to formally exit).

**Terminal outcome — now required and persisted.** Moving to `TERMINAL` without a `terminalOutcome` in the request body is rejected (`400`, listing the 6 valid values). Verified live end-to-end: a real transition with `terminalOutcome: "DENIED"` persisted correctly to `staff_applicants.terminal_outcome`. The pre-existing (but until now non-functional — see §F) DR auto-terminate path also correctly sets this.

**Terminal is read-only**, confirmed two ways: the FSM's own `VALID_TRANSITIONS[TERMINAL] = []` still rejects any further stage change (`"Invalid transition: TERMINAL → S2_VERIFY. Allowed: "` — unchanged Phase 1 behavior), and the `PATCH /staff/:id` bypass fix above independently blocks direct mutation regardless of current stage.

---

## E. Deployment Eligibility Gates — Server-Enforced, Transactional

Implemented using only the 5 already-implemented pillars, as instructed — nothing for Pillars 6–9 (no SOW/indemnity/right-to-refuse/incident workflow exists to check against).

| Series | Gates checked |
|---|---|
| **MAID** | PV must not be ADVERSE (pending is the documented exception — allowed); video complete (9 RM-approved prompts); signed agreement |
| **SC** | PV must be CLEAR; video complete (10); signed agreement; medical CLEAR |
| **UC** | Same as SC (10 prompts) |
| **DR** | PV CLEAR; video complete (12); signed agreement; medical CLEAR; DL verified CLEAR (Pillar 1); eChallan checked, blocks only on severe (≥3, matching the existing DR-07 threshold already in the scenario router — not a new number); practical test PASSED |

**A prerequisite this needed that didn't exist yet:** `verifyDrivingLicence()`/`checkEchallan()` returned results straight to the caller with nothing persisted — no durable record that a DL was ever checked, so nothing could gate on it. Added `staff_id` (optional, backward-compatible) to both endpoints and upsert to `VerificationTrack` (the enum literally already had unused `SARATHI_API`/`ECHALLAN_API` track types anticipating exactly this).

**Full live test matrix** (real SC applicant walked through the entire pipeline, one prerequisite fixed at a time):

| Prerequisite state | Expected | Actual |
|---|---|---|
| Nothing set (fresh S4) | Blocked | ✅ 400, all 4 SC blockers listed (PV/video/agreement/medical) |
| PV set CLEAR | Blocked, 1 fewer reason | ✅ 400, 3 blockers (PV reason gone) |
| + 10 video certs APPROVED | Blocked, 1 fewer reason | ✅ 400, 2 blockers (video reason gone) |
| + signed agreement | Blocked, medical only | ✅ 400, 1 blocker |
| + medical CLEAR | **Allowed** | ✅ 200, `scenario_code: "SC-01"`, stage → S5_DEPLOY |
| DR, nothing set | Blocked, 7 reasons | ✅ 400, all 7 (PV/video-12/agreement/medical/DL/eChallan/practical) |

Every blocked attempt confirmed **fully transactional**: DB queried after each rejection showed the stage unchanged and zero `S5_DEPLOY` events created — no partial state, matching the requirement exactly ("no false deployment event should be created").

---

## F. DR Practical Test — 3-Attempt Limit (a second bug found and fixed)

While implementing this, discovered `assessments.service.ts` (the module that already had the 3-attempt-limit *logic* written) was querying columns that **don't exist on the live table** — a TypeORM entity (`candidate_id`, `assessment_type`, `scenario_code`, `score`) that never matched what Prisma's `db push` actually created (`staff_id`, `skill_scores` jsonb, `overreach_flags` jsonb). Every call to this controller would have thrown `column "candidate_id" does not exist`. The referenced `assessment_audit_logs` table didn't exist in the database at all.

Rewrote `assessments.service.ts` against the real Prisma-backed schema, preserving the exact intended business logic — "assessment type" now lives in `skillScores.assessmentType` (the JSON field that already existed for this kind of flexible data) since there's no dedicated column; audit logging switched to the app's real, working `AuditService`/`AuditLog`.

**Verified live, full sequence:**

| Attempt | Result | Expected | Actual |
|---|---|---|---|
| 1 | FAIL | allowed | ✅ created |
| 2 | FAIL | allowed | ✅ created |
| 3 | FAIL | allowed, **and** triggers auto-terminate | ✅ created, response included `autoTerminated: true, terminalOutcome: "DENIED"`; DB confirmed `pipeline_stage=TERMINAL, terminal_outcome=DENIED, current_scenario=DR-09` |
| 4 | — | **rejected** | ✅ `400`: "DR series practical test limit of 3 attempts reached. Candidate must be terminated (DR-09)." |

---

## G. Phase 1 + Phase 2 Regression

Re-run in full against the final Phase 3 build, fresh tokens for every role:

| Check | Result |
|---|---|
| STAFF pipeline advance | 403 (unchanged) |
| CLIENT finance/payroll, video-cert list | 403 (unchanged) |
| FINANCE `GET /staff` | 403 (unchanged) |
| RM restricted-list **write** (read-only role) | 403 (unchanged) |
| RM `GET /staff`, FINANCE `finance/payroll` | 200 (unchanged) |
| BM restricted-list **add** | 201 (unchanged) |
| App DB role | `homegenny_user`, `rolsuper: false` (unchanged) |
| `pipeline_events` UPDATE | Rejected by DB trigger (unchanged) |
| Deactivated user + old token → `/auth/me` | 401 (unchanged) |

Zero regressions.

---

## H. Remaining Work (explicitly Phase 4, not touched)

- **PF interpretation** — flagged, not resolved (§A). Needs your decision before either engine changes further.
- **Historical financial records** — investigated, not modified (§A). Needs your decision on regenerating the 4 affected draft/internal records.
- **Liability Pillars 6–9** (Scope of Work, Client Indemnity, Right to Refuse, Incident Trail) — no workflow exists; deployment gate correctly can't check what isn't implemented.
- **Trial-to-confirmed, mutual exit, late exit, upgrade path** — no dedicated endpoints existed before this phase and none were added; nothing here contradicts them since they sit entirely after S5_DEPLOY, outside this phase's transition set.
- **Mobile apps, real SMS/WhatsApp providers, cron consolidation, Razorpay webhook signature verification** — all still absent, all prior-phase findings, unrelated to core workflow correctness.
- **eChallan "moderate" case (1–2 violations, DR-08)** — deliberately not a hard deployment block (only ≥3 is), matching the existing scenario router's own severity split; still recorded and will surface via the scenario code the router returns.
- A handful of other tables hit the same "missing DB-level default" class of bug already seen in earlier phases (`agreements.updated_at` had none — discovered while building the test fixtures, worked around in the test data rather than patched, since it wasn't a named finding and touching schema defaults broadly is a bigger, separate cleanup).
- The old, now-unused TypeORM `Assessment`/`AssessmentAuditLog` entity files (`src/modules/assessments/entities/`) were left on disk (orphaned, no longer imported anywhere) rather than deleted — low-risk follow-up cleanup, not correctness-relevant.

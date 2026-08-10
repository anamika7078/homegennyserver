# HomeGenny — Production Audit Report

**Audited against:** HomeGenny Platform v1.0 — User Roles & Permissions Reference
**Date:** 2026-08-10
**Scope:** `homegennyserver` (NestJS API) + `homegenny` (Next.js web portal)
**Method:** static code review of all 56 controllers / FSM / finance engines, plus live
authenticated API testing against a running instance with real seeded roles and two
real branches. All test data created during the audit was removed afterwards.

> **Verification note.** Every FAIL below was reproduced live against the running API
> unless explicitly marked *(code review only)*. Findings I could not verify are marked
> as such rather than asserted.

---

## 0. Two findings that change the premise — read first

### 0.1 Self-registration contradicts the specification

The spec is explicit in two places:

- Role 1 — Staff Applicant: *"Staff do not self-register; they are onboarded by a
  Relationship Manager (RM) who creates their account and assigns their staff code."*
- Role 2 — Client/Family: *"Clients are created by the RM when a placement is being set up."*

The API currently exposes **public, unauthenticated** self-registration for both:

- `POST /api/v1/auth/register/customer`
- `POST /api/v1/auth/register/staff`

These were added earlier the same day as this audit and pushed to
`anamikaelikem7078/homegennyserver`. They are **directly contrary to the spec** and are
also the mechanism by which the audit obtained STAFF and CLIENT tokens used to prove
several privilege-escalation findings below.

This needs a product decision, not a silent code fix — either the spec changes, or these
two endpoints are withdrawn/put behind RM authentication. It is flagged as
**CRITICAL / SPEC CONFLICT** and is listed first because several other findings
compound with it.

### 0.2 Two of three documented access surfaces do not exist

The spec defines three surfaces: Staff Mobile App (React Native/Expo), Client Mobile App
(React Native/Expo), and Web Portal (Next.js 14).

The workspace contains only `homegenny` (`@homegenny/frontend-web`, Next.js) and
`homegennyserver`. There is no Expo/React Native project, no `app.json`, no mobile
source anywhere.

**Consequence:** every Staff-role and Client-role requirement in the spec is
**NOT IMPLEMENTED at the surface level.** Staff and Client permissions were therefore
audited at the API layer only — which is where the real damage was found, since the API
does not enforce those role boundaries either.

---

## A. Overall Audit Summary

| Metric | Count |
|---|---|
| Requirements checked | 118 |
| Workflows checked | 22 |
| Scenarios / live probes executed | 61 |
| **PASS** | 24 |
| **PARTIAL** | 13 |
| **FAIL** | 31 |
| **NOT IMPLEMENTED** | 50 |

Severity spread across FAIL + NOT IMPLEMENTED: **CRITICAL 14 · HIGH 22 · MEDIUM 33 · LOW 12**

**Headline:** the FSM, the statutory payroll engine, Admin 2FA, second-Admin confirmation
and the staff-module branch scoping are genuinely well built. But the authorization layer
that is supposed to sit in front of all of it is largely absent — `RolesGuard`
default-allows, 12 live controllers carry no role restriction at all, and the DB-level
append-only guarantee was never applied. The result is that the documented permission
matrix is not enforced for most modules, and the 9-Pillar Liability Shield is fully
bypassable.

---

## B. Role-wise Result

| Role | Verdict | Summary |
|---|---|---|
| **Staff Applicant** | **FAIL (CRITICAL)** | No mobile app. At API level a STAFF token drove an SC-series applicant S1→S5_DEPLOY with `pv_status=NOT_INITIATED`, and can trigger DL/Aadhaar/PV/medical verification, read other staff's video certs, and read EOR payroll. Every "Staff CANNOT" bullet in the spec is violated except video deletion. |
| **Client / Family** | **FAIL (CRITICAL)** | No mobile app. A CLIENT token can advance pipeline stages, trigger DL verification, enumerate video certifications, and read EOR payroll. Placement dashboard / incident / exit-request / Razorpay payment flows are absent. |
| **Relationship Manager** | **PARTIAL** | Core capability present and branch-scoped for the staff module (verified: RM-A saw 19 staff, RM-B saw 9). But RM can also write to the restricted list (spec: BM-only) and modify payroll-adjacent modules; nothing stops FSM abuse. |
| **Branch Manager** | **PARTIAL** | Restricted-list, escalation and compliance surfaces exist but are not BM-exclusive. Scenario-code override has no "documented reason" enforcement. Compliance/report controllers are stubs. |
| **Finance** | **FAIL (HIGH)** | Finance can read staff pipeline records and trigger DL verification — spec forbids both. Commercial calculator applies GST to the whole cost including salary (see D.1). Finance sub-controllers carry no `@Roles` at all. |
| **Admin** | **PARTIAL (good core)** | TOTP enforced ✓, 8-hour wall enforced ✓, second-Admin confirmation for ADMIN grants ✓, FSM not editable ✓, video content immutable (metadata-only flag) ✓. But append-only is not enforced at DB level ✗ and the app connects as superuser ✗. |

---

## C. Security Findings

| # | Severity | Finding | Evidence | Root cause |
|---|---|---|---|---|
| C1 | **CRITICAL** | `RolesGuard` **default-allows** when no `@Roles` is present — `if (!requiredRoles) return true`. Any controller without an explicit role list is open to every authenticated role. | [roles.guard.ts:14-16](src/modules/auth/guards/roles.guard.ts#L14-L16) | Authorization design: fail-open instead of fail-closed |
| C2 | **CRITICAL** | **Pipeline FSM has no role check.** A STAFF token advanced an applicant S1_INTAKE→S2_VERIFY→S3_TRAIN→S4_AGREEMENTS→**S5_DEPLOY**, all four returning `success:true`. Spec: Pipeline FSM Staff="–", "Cannot advance their own pipeline stage — only RM/Admin". | Live. All 4 events written to `pipeline_events` with `actor_id` of a STAFF user | `pipeline.controller.ts` has `JwtAuthGuard` but no `RolesGuard`/`@Roles` |
| C3 | **CRITICAL** | **Restricted list is writable by every role.** Handler is documented `"(BM only)"` but carries no `@Roles`. STAFF/CLIENT/RM/FINANCE all reached the service (HTTP 500 from an internal error, **not** 403 — authorization never rejected them). Spec: BM=Y, RM=R only. | Live | Missing `@Roles(BM, ADMIN)` |
| C4 | **CRITICAL** | `added_by` on restricted-list entries is taken from the **request body**, not the JWT — the actor on a restricted-list entry can be forged. | [restricted-list.controller.ts:11](src/modules/restricted-list/restricted-list.controller.ts#L11) | Trusting client-supplied actor identity |
| C5 | **CRITICAL** | **Append-only is not enforced at DB level.** `UPDATE` and `DELETE` on `pipeline_events` both succeeded (proven in a rolled-back transaction). Zero triggers exist in the database. Spec: *"append-only is enforced at DB level (INSERT only, no UPDATE/DELETE)"*. | Live | `prisma/apply-triggers.ts` exists but is wired into **no** npm script; `prisma:fix` actively marks migration `20260528000000_admin_security_triggers` as *rolled-back*, and `db push` never runs migrations |
| C6 | **HIGH** | App connects to Postgres as **`postgres` superuser** (`usesuper=true`). Spec requires the app user to lack UPDATE/DELETE on audit tables; a superuser also bypasses RLS and any future grant model. | Live | Deployment/credential configuration |
| C7 | **HIGH** | **Deactivation and logout do not revoke live access tokens.** After setting `is_active=false`, `GET /auth/me` still returned 200; after `POST /auth/logout-all`, still 200. `JwtStrategy.validate()` never touches the DB — no `is_active`, no `active_session_id`/`sid` check. | Live | [jwt.strategy.ts:37-56](src/modules/auth/strategies/jwt.strategy.ts#L37-L56) |
| C8 | **HIGH** | Single-active-session eviction is cosmetic — it clears `refresh_token_hash` only, so the previous device keeps working until its 15-minute access token expires. | Code review | Same as C7 |
| C9 | **HIGH** | **Verification (Pillars 1/3/4) callable by any role.** `POST /verification/dl` returned **201 for STAFF, CLIENT and FINANCE**. Spec: RM=Y, BM=R, Staff/Client/Finance="–". PV and medical submission endpoints are equally open. | Live | No `@Roles` on `verification.controller.ts` |
| C10 | **HIGH** | **Client can reach video certifications.** `GET /video-cert/list/:staffId` returned 200 for a CLIENT token. Spec: Video Certification Client="–", *"Cannot watch video certifications independently (RM-supervised only)"*. `POST /video-cert/view-url` (signed playback URL) is likewise unrestricted. | Live | Only `never-delete` carries `@Roles(ADMIN)` |
| C11 | **HIGH** | **IDOR on video certs.** A STAFF token read `GET /video-cert/list/{other staff id}` → 200. Spec: *"Cannot view other staff applicants' data"*. No ownership check anywhere in the handler. | Live | No ownership/branch predicate |
| C12 | **HIGH** | **EOR payroll readable by Staff and Client.** `GET /finance/payroll` → 200 for both. Spec: Staff="–", Client="–". | Live | Finance sub-controllers have `JwtAuthGuard` but no `@Roles` |
| C13 | **HIGH** | **Finance can read staff pipeline records.** `GET /staff` → 200 for FINANCE. Spec: *"Cannot access pipeline data, scenario codes, or staff verification records"*. | Live | No role restriction on `staff.controller.ts` |
| C14 | **HIGH** | **4 live controllers have no authentication at all** — `assessments` (`/api/v1/assessments`), `competency`, `driver-tests`, `schedules`. These include the DR practical-test and competency endpoints (Pillar 2). | Code review + route table | No `JwtAuthGuard` |
| C15 | **MEDIUM** | `PermissionsGuard` and the whole `rbac` permission model exist but are **applied to zero controllers**. `/auth/me` returns `permissions: []` for CLIENT. The fine-grained permission system is decorative. | Live + code review | Never wired up |
| C16 | **MEDIUM** | Branch isolation absent outside the staff/rm/training modules. Only 6 files import `branch-scope.util`; `pipeline`, `verification`, `video-cert`, `restricted-list`, `placement`, `employees`, `clients` and all finance modules have no branch predicate. RM/BM cross-branch access is therefore possible on those modules. | Code review | No shared branch-scoping middleware |
| C17 | **MEDIUM** | Global throttle is 100 req/min; only the 3 auth endpoints hardened to 5/min during this session. All other endpoints remain at 100/min. | Code review | — |
| C18 | **LOW** | Double `/api` prefix on 3 controllers → routes served at `/api/api/driver-tests/*`, `/api/api/competency/*`, `/api/api/schedules/*`, unversioned. | Route table | `@Controller('api/...')` combined with global prefix `api` |

---

## D. Financial Findings

| # | Severity | Finding | Evidence | Root cause |
|---|---|---|---|---|
| D1 | **CRITICAL** | **GST is applied to the entire monthly cost including staff salary.** `commercial.service.ts:310` computes `gst = monthlyCost * (gstPct/100)` where `monthlyCost` includes salary, employer PF, ESIC, bonus, leave wages, LWF, uniform **and** the management fee. Spec: *"GST (18%) applied ONLY on the management fee component. NEVER applied to the staff salary component. This is a hardcoded business rule enforced at the API level."* | **Live stored data.** Row: `subtotal4=21,945.00`, `management_fee=1,206.97`, `training=300`, `resources=10` → `monthly_cost=234,519.74`, **stored `gst=42,213.55`**. Spec-correct GST = fee only = 12,069.70 × 18% = **2,172.55**. **Overcharge ₹40,041.00/month on this single quotation** (3 such rows found). | [commercial.service.ts:310](src/modules/finance/commercial/commercial.service.ts#L310) |
| D2 | **HIGH** | **Five divergent calculation engines** implement the same statutory rules: `payroll/payroll.service.ts`, `payroll/enterprise-payroll.service.ts`, `finance/commercial/commercial.service.ts`, `finance/esic/esic.service.ts`, `finance/invoice/invoice.service.ts`. They disagree on GST base, PF base and ESIC ceiling, so Form → Preview → API → DB → Payroll → Invoice are not guaranteed to agree. | Code review | Business rules duplicated instead of centralised |
| D3 | **HIGH** | **ESIC ₹21,000 ceiling not applied in the commercial calculator.** ESIC there is gated by a config boolean (`esic_applicable`), not by `gross <= 21000`, so ESIC is charged above the statutory ceiling. Spec: *"Applicable only when gross salary ≤ ₹21,000/month."* | Code review | [commercial.service.ts:293](src/modules/finance/commercial/commercial.service.ts#L293) |
| D4 | **MEDIUM** | **PF ₹15,000 gate not applied in the commercial calculator**, and PF base is `basic + skilled allowance + leave wages` rather than salary. Employer PF default rate is **13%**, not the documented 12%. | Code review | [commercial.service.ts:248,288-290](src/modules/finance/commercial/commercial.service.ts#L288-L290) |
| D5 | **MEDIUM** | **Net salary formula deviates.** Commercial calculator computes `net = gross − PF_ee − ESIC_ee − professionalTax`. Spec: `Net = Gross − ESIC employee − PF employee` (no professional tax term). | Code review | [commercial.service.ts:318](src/modules/finance/commercial/commercial.service.ts#L318) |
| D6 | **MEDIUM** | `enterprise-payroll.service.ts` computes PF on **basic** (not gross/first-15k), applies only employee ESIC, and adds a ₹200 professional-tax cliff above ₹15,000 — none of which matches the spec. | Code review | Third parallel engine |
| D7 | **MEDIUM** | `queuePayrollBatch()` returns **hardcoded fake results** (`staff_count: 14`, `total_inr: 328000`, `razorpay_scheduled: true`) regardless of input. The documented "Payroll Run" capability is a stub that reports success. | [payroll.service.ts:82-105](src/modules/payroll/payroll.service.ts#L82-L105) | Demo scaffolding left in place |
| D8 | **LOW** | Invoice line items for the HR-payroll branch present employee ESIC/PF as **negative amounts on a client-facing invoice** document, conflating a payslip with a client invoice. | [invoice.service.ts:173-178](src/modules/finance/invoice/invoice.service.ts#L173-L178) | — |
| — | **PASS** | `modules/payroll/payroll.service.ts` `calculatePayroll*()` is **correct on every documented rule**: ESIC 0.75/3.25 gated at ≤21,000; PF 12% both sides on `min(gross, 15000)`; `net = gross − esic_ee − pf_ee`; GST on fee only; `clientTotal = gross + esic_er + pf_er + fee + gst`. This is the engine the others should defer to. | [payroll.service.ts:136-185](src/modules/payroll/payroll.service.ts#L136-L185) | — |

> **Spec ambiguity to resolve (not a defect):** the PF row says both *"12% on first ₹15,000 of salary"* (implies a cap applied to all salaries) and *"Applied when salary ≤ ₹15,000"* (implies a cliff above which no PF applies). `payroll.service.ts` implements the cap reading. Please confirm which is intended before any engine is changed.

---

## E. Workflow / FSM Findings

| # | Severity | Finding | Evidence | Root cause |
|---|---|---|---|---|
| E1 | **CRITICAL** | **No liability gates on deployment.** `S4_AGREEMENTS → S5_DEPLOY` is permitted unconditionally. Proven: an SC-series applicant reached `S5_DEPLOY` with `pv_status = NOT_INITIATED`, no video cert, no agreement, no medical. Spec: SC/UC/DR *"Must have CLEAR PV before deployment"*, and all 9 pillars must be validated pre-deployment. | Live | `VALID_TRANSITIONS` encodes stage topology only — no predicate on `pv_status`, `verified_docs`, video cert or practical test |
| E2 | **CRITICAL** | **Scenario routing is disconnected from the pipeline.** `routeScenario()` is a pure advisory function exposed on its own endpoint; `advanceStage()` never calls it. `staff_applicants.current_scenario` stayed `null` through all 4 transitions and `pipeline_events.scenario_code` was `null` on every row. The 94 scenario codes are effectively decorative. | Live | No integration between router and FSM |
| E3 | **CRITICAL** | **Series enum mismatch breaks 3 of 4 series.** FSM/video-cert use `SC`/`UC`/`DR`; the database enum is `SKILLED_CARE`/`UNSKILLED_CARE`/`DRIVER`. Consequence proven live: `GET /video-cert/prompts/SKILLED_CARE` → **0 prompts**, `UNSKILLED_CARE` → **0**, `DRIVER` → **0**; only `MAID` → 9 works. Passing a DB series value to `routeScenario()` hits `default:` and throws *"Unknown series"*. | Live | Two unreconciled enum vocabularies |
| E4 | **HIGH** | Restricted-list check is **not enforced before intake actions**. It exists only as the first branch of the advisory scenario router; no code path blocks intake or stage advance on a restricted-list hit. Spec: *"Restricted list check (always first, before any other action)"*. | Code review | Advisory-only |
| E5 | **HIGH** | `terminal_outcome` is never written when advancing to `TERMINAL`, so terminal classification (ENROLLED / CONDITIONAL / DEFERRED / DENIED / ABANDONED / LATE_EXIT) is unrecorded. Read-only-when-terminal cannot be enforced either. | Live (`terminal_outcome=null`) | `advanceStage()` only writes `pipeline_stage` |
| E6 | **HIGH** | **Stage-based screen locking not implemented** (no mobile app, and no server-side stage gate). Spec: *"a staff member at S2_VERIFY cannot access Training screens"*, *"Terminal staff member has read-only access"*. | Code review | — |
| E7 | **MEDIUM** | DR-specific gates — DL expiry/suspension, eChallan threshold, practical test max-3-attempts — exist only as scenario-router flag reads. No enforcement blocks progression, and the practical-test endpoints are unauthenticated (C14). | Code review | — |
| E8 | **MEDIUM** | `staff_applicants.updated_at` has **no database default**, so any raw-SQL insert path fails with a not-null violation (hit during this audit). Same class of bug the FSM code already works around for `pipeline_events.id`. | Live | Prisma `@updatedAt` is ORM-level only |
| E9 | **MEDIUM** | Trial monitor / trial-to-confirmed conversion / mutual-exit / late-exit / upgrade-path flows: no dedicated endpoints found. Spec requires these as RM capabilities with BM final authority on DR-20/SC-17/UC-17/M3X-14. | Code review | NOT IMPLEMENTED |
| — | **PASS** | Transition **validity** is correctly server-validated against `VALID_TRANSITIONS` — invalid jumps are rejected with 400 and cannot be forced via payload or URL. | Live | — |
| — | **PASS** | `actor_id` cannot be spoofed: the controller overwrites it from `req.user.id`, ignoring any body value. Every transition wrote an event row. | Live | — |
| — | **PASS** | Concurrency is handled — `SELECT … FOR UPDATE` inside a transaction prevents double-advance races. | Code review | — |

---

## F. Notification Findings

| # | Severity | Finding |
|---|---|---|
| F1 | **HIGH** | **SMS and WhatsApp are console-log stubs.** `sendSms()` logs `[MSG91] →` or `[SMS_STUB]` and never calls a provider; `sendWhatsApp()` only logs. Every documented SMS/WhatsApp delivery — stage advance, training reminders, DL expiry to staff, video renewal, placement confirmation — is non-functional. Email via nodemailer is the only real channel. |
| F2 | **MEDIUM** | 18 `@Cron` handlers exist across `enterprise-cron.service.ts` and `monitoring.service.ts` against 7 documented cron alerts, with overlapping schedules (two at 6AM, two at 7AM, two at 8AM, three Monday-9AM). No mapping document ties handlers to the 13 documented notification rows; duplicate-delivery risk is real but I did not execute the crons to confirm. |
| F3 | **MEDIUM** | Recipient-fan-out rules are not implemented as specified. Documented tiering — DL expiry *"BM (7-day only)"*, PV renewal *"BM (if >30 days overdue)"*, invoice overdue *"Day 1 / Day 3 / Day 7"*, incident *"RM immediate, BM same-day"* — has no corresponding recipient-selection logic. |
| F4 | **LOW** | `formatMessage()` falls through to a generic `"HomeGenny alert: ${event}"` for every event except the e-sign OTP, so notifications carry no substantive content. |

*Not verified:* I did not trigger live cron runs or assert per-recipient delivery, so F2/F3 are code-review findings rather than reproduced failures.

---

## G. Liability Shield Findings (9 Pillars)

| Pillar | Status | Finding |
|---|---|---|
| **1 — Licence Verified** | **FAIL** | `POST /verification/dl` (Sarathi) callable by STAFF/CLIENT/FINANCE — 201 confirmed live. No BM exception-review workflow. |
| **2 — Competency Proven** | **FAIL** | Practical-test and competency endpoints are **entirely unauthenticated** and served at malformed `/api/api/...` paths. Max-3-attempts is not enforced as a gate. |
| **3 — Medical / Sobriety** | **FAIL** | `POST /verification/medical/submit/:staffId` has no role restriction; a staff member can post their own medical outcome. No borderline-escalation path to BM. |
| **4 — Police Verified** | **FAIL** | `POST /verification/pv/submit/:staffId` unrestricted. Critically, **PV status is not a deployment gate** — SC-series reached S5_DEPLOY at `pv_status=NOT_INITIATED` (E1). Maid pending-PV exception is not modelled as an exception because there is no rule to except. |
| **5 — Video Certified** | **PARTIAL** | Strong parts: SHA-256 verify endpoint exists, `never_delete` is ADMIN-only, and no endpoint deletes or mutates video content — Admin genuinely cannot alter the recording. Broken parts: prompt lists return **0 for 3 of 4 series** (E3), Client can list certs (C10), Staff can read others' certs (C11), and video completeness is not a deployment gate. |
| **6 — Scope of Work** | **NOT IMPLEMENTED** | No SOW create/acknowledge/amend endpoints; no client acknowledgement capture; no BM non-standard approval. |
| **7 — Client Indemnity** | **NOT IMPLEMENTED** | No indemnity-clause send or client-acknowledgement flow. |
| **8 — Right to Refuse** | **NOT IMPLEMENTED** | No right-to-refuse invocation log. |
| **9 — Incident Trail** | **NOT IMPLEMENTED** | No client incident-report endpoint; no RM resolution log; no BM escalation; no Admin legal-hold flag. |

**Net:** 4 pillars fail open, 4 are absent, 1 is partial. Because deployment has no
gate at all (E1), the liability shield provides **no enforced protection** in its
current state — the pillars are recorded aspirations rather than checks.

---

## Detailed findings table

| Role | Module | Scenario | Expected | Actual | Status | Severity | Root Cause |
|---|---|---|---|---|---|---|---|
| All | Auth | Controller without `@Roles` | Deny by default | Allowed for every role | FAIL | CRITICAL | RolesGuard fail-open |
| Staff | Pipeline FSM | Advance own stage | 403 | 200 ×4, reached S5_DEPLOY | FAIL | CRITICAL | No `@Roles` |
| Client | Pipeline FSM | Advance any stage | 403 | Passed authz (400 on unknown id) | FAIL | CRITICAL | No `@Roles` |
| Finance | Pipeline FSM | Advance stage | 403 | Passed authz | FAIL | CRITICAL | No `@Roles` |
| SC series | Deployment | Deploy with PV not initiated | Blocked | Reached S5_DEPLOY | FAIL | CRITICAL | No liability gate |
| Staff/Client/RM/Finance | Restricted List | Add entry | 403 (BM only) | Reached service, no 403 | FAIL | CRITICAL | No `@Roles` |
| All | Restricted List | Actor attribution | From JWT | From request body | FAIL | CRITICAL | Client-supplied actor |
| Admin | Audit log | UPDATE/DELETE pipeline_events | Blocked at DB | Both succeeded | FAIL | CRITICAL | Triggers never applied |
| Finance | Commercial calc | GST base | Management fee only | Whole cost incl. salary | FAIL | CRITICAL | commercial.service.ts:310 |
| All | Scenario routing | Code persisted on transition | Written | Always `null` | FAIL | CRITICAL | Router not called by FSM |
| SC/UC/DR | Video cert | Prompt list | 10/10/12 | 0/0/0 for DB enum values | FAIL | CRITICAL | Series enum mismatch |
| Staff | Mobile app | Staff surface exists | Expo app | Absent | NOT IMPL | CRITICAL | — |
| Client | Mobile app | Client surface exists | Expo app | Absent | NOT IMPL | CRITICAL | — |
| Staff/Client | Registration | RM-created only | Public self-registration live | FAIL | CRITICAL | Spec conflict (§0.1) |
| All | Auth | Deactivate user | Token invalid | Still 200 | FAIL | HIGH | No DB check in JwtStrategy |
| All | Auth | logout-all | Token invalid | Still 200 | FAIL | HIGH | Access token not tracked |
| Staff/Client/Finance | Verification | Trigger Sarathi DL | 403 | 201 | FAIL | HIGH | No `@Roles` |
| Client | Video cert | List certs | 403 | 200 | FAIL | HIGH | No `@Roles` |
| Staff | Video cert | List another staff's certs | 403 | 200 | FAIL | HIGH | No ownership check |
| Staff/Client | EOR Payroll | Read payroll | 403 | 200 | FAIL | HIGH | No `@Roles` |
| Finance | Staff pipeline | Read staff records | 403 | 200 | FAIL | HIGH | No `@Roles` |
| All | Competency/DR tests | Any access | Authenticated RM | No auth at all | FAIL | HIGH | No JwtAuthGuard |
| All | DB | App DB privileges | Restricted user | superuser | FAIL | HIGH | Config |
| Finance | ESIC | ₹21,000 ceiling | Enforced | Config toggle only | FAIL | HIGH | commercial.service.ts:293 |
| All | Notifications | SMS/WhatsApp send | Delivered | Console log only | FAIL | HIGH | Stub dispatcher |
| All | FSM | Restricted-list check first | Blocks intake | Advisory only | FAIL | HIGH | Not wired |
| All | FSM | Terminal outcome recorded | Set | `null` | FAIL | HIGH | Not written |
| RM/BM | Most modules | Cross-branch access | Isolated | No branch predicate | FAIL | MEDIUM | No shared scoping |
| All | RBAC | Permission enforcement | Enforced | Guard unused | FAIL | MEDIUM | Never wired |
| Finance | PF | ₹15,000 gate + 12% rate | Per spec | No gate, 13% default | FAIL | MEDIUM | commercial.service.ts |
| Finance | Net salary | Gross − ESIC_ee − PF_ee | Also subtracts prof. tax | FAIL | MEDIUM | commercial.service.ts:318 |
| Finance | Payroll Run | Real batch | Hardcoded 14 staff / ₹328,000 | FAIL | MEDIUM | Demo stub |
| BM | Compliance/Reports | DPDP reports, audit export | Controllers are empty stubs | NOT IMPL | MEDIUM | 7 stub controllers |
| Client | Placement/Invoice/Incident/Exit | Full client journey | No endpoints | NOT IMPL | HIGH | — |
| All | Pillars 6–9 | SOW, indemnity, refusal, incident | No endpoints | NOT IMPL | HIGH | — |
| Admin | 2FA | TOTP enforced | `requires_2fa: true` | **PASS** | — | — |
| Admin | Session | 8-hour hard wall | Enforced in strategy + refresh | **PASS** | — | — |
| Admin | ADMIN grant | Second-Admin confirmation | Implemented, self-approval blocked | **PASS** | — | — |
| Admin | FSM config | Cannot modify FSM | Hardcoded, no write path | **PASS** | — | — |
| Admin | Video override | Metadata flag only | `never_delete` only; content immutable | **PASS** | — | — |
| RM | Staff list | Branch scoping | RM-A 19 vs RM-B 9 | **PASS** | — | — |
| All | FSM | Invalid transition rejected | 400, unforgeable | **PASS** | — | — |
| All | FSM | actor_id from JWT | Body value ignored | **PASS** | — | — |
| All | FSM | Concurrent advance | `FOR UPDATE` lock | **PASS** | — | — |
| Finance | payroll.service | All statutory formulas | Correct per spec | **PASS** | — | — |

---

## Recommended fix order

Fixes are deliberately **not** applied yet — several depend on decisions only you can make
(§0.1 especially). Suggested sequence, smallest-safe-change first:

**Phase 1 — stop the bleeding (no behaviour change for legitimate users)**
1. Make `RolesGuard` fail-closed, or register it globally with an explicit `@Public()`
   opt-out. Single highest-leverage fix — it closes C2, C3, C9–C13 at once.
   *Must be paired with adding `@Roles` to every controller in the same change, or
   legitimate traffic breaks.*
2. Add `@Roles` per the documented matrix to the 12 unrestricted live controllers.
3. Add `JwtAuthGuard` to `assessments`, `competency`, `driver-tests`, `schedules`; fix
   the `/api/api` double prefix.
4. Take `added_by` from `req.user.id` in the restricted-list handler.

**Phase 2 — restore the documented guarantees**
5. Apply the append-only triggers and remove `admin_security_triggers` from
   `prisma:fix`'s rolled-back list; move off the `postgres` superuser.
6. Add `is_active` + `active_session_id` checks to `JwtStrategy.validate()` (accept the
   per-request DB read, or cache briefly).

**Phase 3 — correctness**
7. Fix GST base in `commercial.service.ts` to management fee only; **quantify and
   reconcile already-issued quotations/invoices** before changing it, since stored
   totals are wrong today.
8. Centralise statutory rules on `payroll.service.ts` and delete the other four engines'
   duplicate logic.
9. Reconcile the series enum to one vocabulary; add a mapping layer if the DB enum must stay.
10. Add deployment predicates (PV/video/agreement/practical) to `S4→S5`; call
    `routeScenario()` from `advanceStage()` and persist `scenario_code` + `terminal_outcome`.

**Phase 4 — build what's missing**
11. Mobile surfaces, Pillars 6–9, client journey, real SMS/WhatsApp providers,
    trial/exit/upgrade flows, the 7 stub controllers.

Each phase should be followed by a re-run of this audit's live probes before moving on.

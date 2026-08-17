# HomeGenny Product Spec — Reference Digest

Condensed from 4 source documents the user provided (kept as the exhaustive detail — this file is
a navigable index + a **spec-vs-actual-implementation gap list**, which is the part not in the
source docs). Source docs, for full detail:
- `HomeGenny_StageDescriptions.pdf` — full narrative for all 8 pipeline stages, all 94 scenario codes
- `HomeGenny_UserRoles.pdf` — 6 roles, permissions matrix, 9-Pillar Shield role participation
- `HomeGenny_Merged.html` — BM web portal UI mockup (dashboard, alarms, kanban, intake, video, agreements, payroll, monitoring, system status)
- `HomeGenny_UIUXFlow_Complete.html` — full mobile UI/UX flow mockup (all stages, all roles, screen-by-screen)

## 1. Pipeline FSM — 8 stages

```
S1_INTAKE → S2_VERIFY → S2_5_ASSESS (DR only) → S3_TRAIN → S4_AGREEMENTS → S5_DEPLOY
                ↓              ↓                    ↓
             Deferred ←────────┴────────────────────┘ → Terminal
```

Valid transitions table (server-enforced, every transition = an append-only `pipeline_events` row
with actor_id/timestamp/reason_code/payload):

| From | Valid next |
|---|---|
| S1_INTAKE | S2_VERIFY · Terminal |
| S2_VERIFY | S2_5_ASSESS (DR only) · S3_TRAIN · Deferred · Terminal |
| S2_5_ASSESS | S3_TRAIN · Deferred · Terminal |
| S3_TRAIN | S4_AGREEMENTS · Deferred · Terminal |
| S4_AGREEMENTS | S5_DEPLOY · Terminal |
| S5_DEPLOY | Terminal |
| Deferred | S2_VERIFY · S3_TRAIN · Terminal |
| Terminal | none — final state |

### S1 — Intake
- **Purpose**: identity capture + restricted-list check + series assignment. Deliberately lightweight — no docs, no testing, no agreements here.
- **Restricted-list check is mandatory first action**, before any record exists. Match → record created directly at `TERMINAL`/`RESTRICTED`, scenario `DR-04`/`SC-04`/`UC-04`/`M3X-04`.
- Deposit collected at intake: **DR ₹2,000 · SC ₹1,500 · UC ₹1,000 · Maid ₹500** (refundable).
- Actor: RM creates the record (`staff_code` = `[SERIES][BRANCH][SEQ]`), BM only gets alerted on a restricted match.

### S2 — Verification (5 parallel tracks)
| Track | Series | What it checks |
|---|---|---|
| 1. Aadhaar eKYC | All (mandatory) | UIDAI OTP eKYC. Only last-4 digits + SHA-256 hash retained, never full number. 2 attempts before terminal (`DR/SC/UC/M3X-03`). |
| 2. DL Verify | DR only | Sarathi API — status VALID/EXPIRED/SUSPENDED/REVOKED, vehicle classes. Expired → `DR-05`; suspended/revoked → `DR-06`. |
| 3. eChallan | DR only | 0 = clear · 1–2 = conditional registration `DR-08` (disclosed to client) · 3+ = denial `DR-07`. Re-checked **daily** even post-deployment. |
| 4. Police Verification | All, outcome varies | CLEAR → all series proceed. PENDING → **only Maid** may deploy (`M3X-06`, must resolve in 30 days); SC/UC/DR must wait. FAILED → terminal (`DR-11`/`SC-06`/`UC-05`/`M3X-05`). Annual renewal (alert at 11mo). |
| 5. Medical/Sobriety | DR + SC only | Failed → `DR-12`/`SC-05`, reapply after 90 days. |

### S2.5 — Practical Assessment (DR only)
- Real-world driving test, up to **3 attempts**. Attempt 1/2 fail → deferred (`DR-10`, 7-day then 14-day wait). 3rd fail → terminal `DR-09`, deposit forfeited, 12-month re-apply ban.
- Vehicle-type deployment matrix keyed off DL class + language tier (e.g. Hatchback needs LMV+T3, Heavy Vehicle needs HMV+T2).

### S3 — Training
- Duration: **Maid 3d · UC 5d · SC 7d · DR 5d**, series-specific curriculum (full day-by-day breakdown in source PDF).
- Culminates in **Video Self-Certification** — the Pillar 5 legal record. Prompt counts: **Maid 9 (min 270s) · UC 10 (min 300s) · SC 10 (min 300s) · DR 12 (min 360s)**.
- Video: SHA-256 hashed, RM reviews within 24h (approve or reject-with-reason, max 3 attempts), `never_delete=false` by default with `retention_until` = 7yr post-exit; RM/Admin can force `never_delete=true` for fraud/legal holds.
- Incomplete video cert → terminal (`DR-14`/`SC-10`/`UC-07`/`M3X-07`).
- Abandonment during training: 2 contact attempts over 48h → terminal, deposit forfeited if training had started.

### S4 — Agreements (3 instruments, sequential: A1 → A2 → A3)
| # | Name | Parties | Content |
|---|---|---|---|
| A1 | EOR Employment Contract | HomeGenny ↔ Staff | Employment relationship, salary/deductions, conduct, reassignment rights, series Schedule A/B/C/D |
| A2 | Scope of Work (SOW) | HomeGenny ↔ Staff ↔ Client | Duties, hours, exclusions, vehicle/routes (DR), household specifics — **the reference document for all future scope disputes** |
| A3 | Client Indemnity | Client only | Ack of certs reviewed, liability limited to SOW, 24-month no-direct-engagement, incidents outside SOW = client responsibility |
- All signed via eSign OTP. Rejection → RM documents clause + reason → BM reviews → amend or terminal (`DR-15`/`SC-11`/`UC-08`/`M3X-08`, deposit held 7 days pending resolution).
- The UI/UX mockup describes a richer set of rejection sub-scenarios (S4-REJ-01 through 07: partial clause objection, full refusal, SOW revision cycles capped at 3, indemnity refusal on non-negotiable clauses, 7-day agreement-link timeout, OTP failure lockout, post-partial-signing withdrawal) — **useful UX detail, not all of it is literally coded as distinct backend states today** (see §6 gaps).
- Mockup also references **A4 (Medical Addendum, SC)** and **A5 (Medical Exclusion Clause, UC)** as additional instruments beyond A1/A2/A3 — **not present in the backend's Agreement model today** (see §6).

### S5 — Deployment
- **Trial length**: Maid 7d · UC 7d · SC 14d · DR 7d. Extendable once by mutual agreement.
- Post-trial: client confirms (→ CONFIRMED) / rejects / staff exits / both extend / both mutual-exit.
- **Shift logging**: check-in/out with GPS via mobile app, client can confirm/flag.
- **Monthly payroll** (Finance, last day of month): shift days from approved logs → gross salary → ESIC/PF deducted → net via Razorpay → client invoice = salary + employer ESIC/PF + management fee + 18% GST **on the fee only, never on salary** (hardcoded rule).
- **7 monitoring cron jobs**, all running continuously: DL expiry (60/30/7d), eChallan (daily), PV renewal (11mo), video-cert renewal (11mo), trial expiry (3d prior), invoice overdue (Day 1/3/7), upgrade-path (monthly).

### Deferred (holding pattern, not terminal)
- Triggers: PV pending (SC/UC/DR), practical-test deferral (DR), medical retest wait, applicant-requested pause, training gap, agreement negotiation.
- **Max 90 days**, then auto-terminal (`DEFERRED` timeout outcome). BM can approve an exception extension.
- Re-entry point depends on trigger (e.g. PV-resolved-clear → back to S3_TRAIN or S2_VERIFY; practical retest → S2_5_ASSESS; agreement renegotiated → S4_AGREEMENTS).

### Terminal (final, immutable)
Outcomes: `PLACED` (success) · `REJECTED` · `ABANDONED` · `RESTRICTED` · `DEFERRED` (timeout) · `CANCELLED` · `LATE_EXIT`.

### Late-exit cancellation fee matrix (post-trial exits)
| Exit stage | Fee | Deposit | Goodwill |
|---|---|---|---|
| During trial | Nil | Full refund | — |
| Trial → extended, then exit | 15 days salary | Refund | — |
| Mutual trial exit | Nil | Full refund | — |
| Post-confirm <30d | 30 days salary | Refund | Nil |
| Post-confirm 30–90d | 15 days salary | Refund | 7 days |
| Post-confirm >90d | 7 days salary | Refund | 15 days |

## 2. Scenario codes — 94 total across 4 series

Full per-code table is in the source PDF (`HomeGenny_StageDescriptions.pdf`, pages 16–19) — not
reproduced here in full, but the pattern per series is consistent:

- **DR (21 codes)**: DR-00 (master ref) through DR-20. Covers restricted list, DL issues, eChallan tiers, practical-test attempts, PV/medical, video cert, agreement rejection, trial outcomes (confirm/reject/extend/mutual/deferred-long-term).
- **SC (18 codes)**: SC-00 through SC-17. Same shape minus DL/eChallan/practical-test tracks, plus SC-specific competency-assessment-failure codes (SC-07/08) and upgrade-path (SC-15).
- **UC (18 codes)**: UC-00 through UC-17. Adds UC→SC upgrade path (UC-12) and abandonment variants (UC-13/14).
- **M3X/Maid (15 codes + 8 core docs)**: M3X-00 through M3X-14. Unique code: **M3X-06 "PV Pending — Deploy Allowed"** — the only series exception where PENDING (not CLEAR) PV still permits deployment.

Look up the exact trigger/outcome text for any code in the source PDF when needed — this digest
intentionally doesn't restate all 94 rows.

## 3. User roles & permissions (6 roles, 3 platforms)

| Role | Platform | Core job |
|---|---|---|
| **Staff (ST)** | Staff Mobile App only | The domestic worker. Cannot self-register (RM onboards them), cannot see other staff, cannot advance own pipeline stage, cannot view client contact until confirmed. |
| **Client/Family (CL)** | Client Mobile App only | The household. Cannot terminate a placement directly (must raise exit request via RM), cannot see pipeline/scenario/PV data, cannot modify SOW unilaterally, cannot watch video certs unsupervised. |
| **RM** | Web Portal + Mobile | Front-line operator — intake, verification, training oversight, video-cert sign-off, agreement execution, placement matching, monitoring. The human checkpoint the FSM requires an `actor_id` from at almost every gate. Cannot touch payroll/invoices (Finance-only), cannot add to restricted list (BM-only), cannot override the FSM. |
| **BM (Branch Manager)** | Web Portal | Branch-wide oversight, **owns the restricted list** (add/search/approve removals), escalation authority (disputed abandonment, contested challans, mutual-exit mediation), agreement-template approval, compliance reports. Read-only on pipeline (RM has write). Cannot process payroll, cannot touch other branches. |
| **Finance** | Web Portal (Finance Console) | EOR payroll cycle, ESIC/PF, GST-compliant invoicing, Razorpay settlement, deposit tracking. **No access to pipeline/scenario/verification data at all.** Cannot modify salary structure (RM sets it at placement) or process payroll for unconfirmed placements. |
| **Admin** | Web Portal, full access | Platform-wide: user management, branch config, cross-branch analytics, full audit-log access, video-cert `never_delete` override for fraud/legal, DPDP deletion-request processing, system monitoring. Hardware 2FA enforced, 8h session expiry, cannot self-grant Admin (needs 2nd admin confirm), cannot touch `pipeline_events` (INSERT-only at DB level).

### Permissions matrix (Y=full, R=read-only, –=none)
| Module | Staff | Client | RM | BM | Finance | Admin |
|---|---|---|---|---|---|---|
| Staff Onboarding | Y | – | – | – | – | – |
| Pipeline FSM | – | – | Y | R | – | Y |
| DL/Aadhaar Verify | – | – | Y | R | – | Y |
| Video Certification | Y | – | Y | R | – | Y |
| EOR Payroll | – | – | Y | Y | Y | Y |
| Client Invoicing | – | Y | R | R | Y | Y |
| Matching & Placement | – | – | Y | Y | – | Y |
| Shift Logs | Y | R | Y | R | – | Y |
| Restricted List | – | – | R | Y | – | Y |
| Monitoring/Alerts | – | – | Y | Y | – | Y |
| Reports & Analytics | – | – | R | Y | Y | Y |
| User Management | – | – | – | Y | – | Y |

### 9-Pillar Liability Shield — who does what
1. **Licence Verified** — RM triggers Sarathi, BM reviews exceptions, Admin audits.
2. **Competency Proven** — RM records practical-test result (max 3 attempts, DR), BM signs off exceptions.
3. **Medical/Sobriety** — RM records outcome, BM escalates borderline.
4. **Police Verified** — RM submits + marks clear, Admin overrides for the Maid pending-PV exception.
5. **Video Certified** — Staff records, RM reviews/signs off, Admin sets never-delete for fraud.
6. **Scope of Work** — RM creates at placement, Client acknowledges in-app, BM approves non-standard.
7. **Client Indemnity** — RM sends, Client acknowledges, BM reviews contested cases.
8. **Right to Refuse** — RM logs invocation, BM handles disputes, Admin audits.
9. **Incident Trail** — Client files via app, RM responds/logs resolution, BM escalates, Admin can legal-hold.

## 4. Payroll/EOR rules (hardcoded, Finance domain)
- **GST 18%** applies **only** to the management fee component — **never** to staff salary. Enforced at API level.
- **ESIC**: employee 0.75%, employer 3.25%, only when gross salary ≤ ₹21,000/mo.
- **PF**: employee 12%, employer 12% matching, on **first ₹15,000** of salary (statutory ceiling) — applies when salary ≤ ₹15,000.
- **Net** = Gross − ESIC(employee) − PF(employee), disbursed via Razorpay.
- **Client total charge** = Gross + ESIC(employer) + PF(employer) + Management fee + GST(on fee) — one consolidated invoice.

## 5. Notification routing (who gets what)
| Event | Recipients |
|---|---|
| DL expiry (60/30/7d) | RM (primary), Staff (WhatsApp), BM (7-day mark only) |
| eChallan new violation | RM |
| PV renewal due | RM, BM if >30 days overdue |
| Video cert annual renewal | RM, Staff |
| Trial expiry (3d prior) | RM, Client |
| Invoice overdue | Finance (primary), RM, Client (Day 1/3/7) |
| Upgrade path eligible | RM, BM |
| Restricted list match on intake | RM (immediate block), BM |
| Incident report filed | RM (immediate), BM (same-day) |

## 6. Spec vs. actual backend implementation — known gaps (as of this session)

These are things the spec/UI-mockup docs describe that **do not yet exist as distinct backend
state/endpoints** — flagging so a future session doesn't assume they're built:

- **Placement model is simpler than the mockup implies.** The UI mockups (BM dashboard, UX flow doc) show a rich state machine — `trial_7`/`trial_14`/`extended`/`client_reject`/`staff_exit`/`mutual_exit` as distinct statuses. The **real backend `PlacementStatus` enum has only 4 values**: `TRIAL`, `CONFIRMED`, `EXITED`, `TERMINATED`. This was a deliberate simplification decided earlier this session (frontend gating instead of backend enum expansion) — see `RM_MOBILE_APP_INTEGRATION_PLAN.md` and `RM_CLAUDE_PROMPT.md`.
- **No aggregate "read back verification status" endpoint existed until this session** — now fixed: `GET /verification/:staffId` (added, live-tested).
- **No training-module completion tracking endpoint exists at all.** The mockup's detailed training-checklist screens (module-by-module progress) have no backend model behind them yet.
- **Video-cert approve/reject is TRAINER/ADMIN-only in the real backend**, not RM — despite the spec (§Role 3 RM capabilities, "Video Cert Queue: … Sign off … Reject with reason") explicitly describing this as an RM action. Known, flagged, not fixed (real endpoint: `PUT /trainer/video-certifications/:id/review`).
- **`IncidentType` enum only has 6 values today** (`CLIENT_COMPLAINT`, `STAFF_MISCONDUCT`, `SAFETY_ISSUE`, `ATTENDANCE_FRAUD`, `DRIVING_VIOLATION`, `LATE_EXIT`) — the mockup's client "Raise Issue" screen shows a richer category list (Scope Violation, Absenteeism, Conduct, Property Damage, Invoice Dispute) that matches a **prepared-but-unapplied migration** (`prisma/migrations/20260813000000_extend_incident_type/`, blocked on a Postgres enum-owner permission).
- **A4 (SC Medical Addendum) / A5 (UC Medical Exclusion Clause)** — mentioned in the BM dashboard mockup's "Series Requirements" panel — **have no backing model**; the real `Agreement.type` field is a free-text string, so these could be added as new `type` values without a schema change, but no code currently generates/tracks them as distinct instruments.
- **Agreement rejection sub-scenarios (S4-REJ-01 through 07)** from the UX-flow doc are a UX-design elaboration, not 7 distinct backend states — the real backend just has `Agreement.status`: presumably `DRAFT`/`PENDING`/`SIGNED`/`REJECTED`-shaped (see `AgreementStatus` enum in `schema.prisma`) plus the generic BM-escalation pattern used elsewhere (e.g. `right_to_refuse`, `incidents`) — if building this UI, treat the 7 sub-scenarios as **client-side UX states layered on top of** the simpler backend status, not things to request 7 separate API shapes for.
- **`agreements.client_id` was found and fixed this session** to correctly FK to `finance_customers` (was wrongly pointing at the legacy `clients`/`ClientProfile` table) — same root-cause bug class as SOW/Indemnity/Incidents, all now consistent.
- **Restricted-list check UX** (the mockup's dedicated "Restricted Check" screen with CLEAR/RESTRICTED result cards) maps cleanly to the real `POST /restricted-list/check` (or `POST /staff/check-restricted`) — this one *is* accurately represented in the mockup.
- **BM dashboard "Issues & Alarms" screen** (client complaints, compliance alerts, payment issues, system alerts, all in one triaged inbox with notes/status workflow) has **no single backing endpoint** — real data would need to be composed from `GET /rm/incidents`, `GET /finance/deposits`, monitoring-cron outputs, and system-health endpoints; there's no unified "alarms" resource today.

## 7. Where to go for endpoint-level detail
- `docs/MOBILE_API_REFERENCE.md` — Auth/RM/Staff/Client endpoint list, demo accounts, response shapes.
- `docs/RM_MOBILE_APP_INTEGRATION_PLAN.md` — screen-by-screen plan mapping the *current* dummy-data Flutter RM feature to real endpoints.
- `docs/RM_CLAUDE_PROMPT.md` — ready-to-paste implementation prompt (corrected pipeline-stage naming) derived from the plan above.

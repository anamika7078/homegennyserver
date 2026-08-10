# Phase 1 — Authorization Hardening Report

**Scope:** stop-the-bleeding authorization fixes only, per the audit's Phase 1 objectives.
No payroll/GST/PF/ESIC logic touched, no FSM transition topology changed, no scenario
routing changed, no liability-gate logic added, no mobile apps built, no notification
providers changed. All changes verified live against a running instance with fresh
tokens for STAFF, CLIENT, RM, BM, FINANCE, ADMIN, then test data removed.

---

## 1. RolesGuard — now fails closed

`RolesGuard` previously returned `true` whenever no `@Roles(...)` was declared — any
authenticated user of any role could reach a controller that simply forgot to declare
roles. It's rewritten so every endpoint must be **exactly one** of:

- `@Public()` — no JWT required at all (login, register, refresh, health, root ping,
  the Razorpay webhook)
- `@AnyAuthenticatedRole()` — any logged-in user, own-account only (`/auth/me`,
  logout, 2FA setup)
- `@Roles(...)` — only the listed roles

Anything with **none of the three** is denied with a `403` before it ever reaches the
handler. Both `JwtAuthGuard` and `RolesGuard` are now registered globally
(`app.module.ts`, `APP_GUARD`), so this applies to every controller by default —
authorization is no longer something each controller has to opt into.

**Verified:** a static scan confirms every controller with at least one live HTTP
route now carries one of the three markers. Full source: [roles.guard.ts](src/modules/auth/guards/roles.guard.ts), [public.decorator.ts](src/modules/auth/decorators/public.decorator.ts), [roles.decorator.ts](src/modules/auth/decorators/roles.decorator.ts).

## 2. Controllers secured

| Controller | Before | After |
|---|---|---|
| `pipeline.controller.ts` | `JwtAuthGuard` only, no roles | `@Roles(RM, ADMIN)` |
| `restricted-list.controller.ts` | `JwtAuthGuard` only, no roles | `add()` → `@Roles(BM, ADMIN)`; `check()` → `@Roles(RM, BM, ADMIN)` |
| `verification.controller.ts` | `JwtAuthGuard` only, no roles | `@Roles(RM, ADMIN)` |
| `video-cert.controller.ts` | Only `never-delete` had roles | Per-method roles + STAFF ownership check (below) |
| `finance/payroll`, `deposit`, `settlement` | `JwtAuthGuard` only | `@Roles(RM, BM, FINANCE, ADMIN)` |
| `finance/invoice`, `analytics`, `customer` | `JwtAuthGuard` only | `@Roles(RM, BM, FINANCE, ADMIN)` |
| `finance/esic` (statutory filing) | `JwtAuthGuard` only | `@Roles(FINANCE, ADMIN)` |
| `staff.controller.ts` | `JwtAuthGuard` only | `@Roles(RM, BM, ADMIN)` |
| `placement.controller.ts` | `JwtAuthGuard` only | `@Roles(RM, BM, ADMIN)` |
| `assessments`, `competency`, `driver-tests`, `schedules` | **No auth at all** | `JwtAuthGuard` + `@Roles(RM, ASSESSOR/TRAINER, ADMIN)` |
| `auth.controller.ts` | Mixed, undeclared | `@Public()` on login/register/refresh/password-reset; `@AnyAuthenticatedRole()` on me/logout/2FA |
| `health.controller.ts`, `app.controller.ts` | No auth (correct, but undeclared) | `@Public()` — explicit now, still reachable by infra probes |

## 3. Restricted-list actor identity fixed

`added_by` was read from the request body — forgeable. It's now always
`req.user.id` from the verified JWT; the field was removed from the accepted body
type entirely. **Verified live**: sending `"added_by":"11111111-..."` in the body
is silently ignored — the persisted row shows the real BM's user ID.

A pre-existing bug was hit while verifying this (`restricted_list.id` had no
DB-level default, so every insert 500'd regardless of role) — same class of defect
the original audit already flagged on `staff_applicants.updated_at` and
`pipeline_events.id`. Fixed with the same one-line pattern already used for
`pipeline_events` (`gen_random_uuid()` in the insert), since without it the
BM-write-to-restricted-list path the ticket explicitly asks to verify could not be
demonstrated at all. No other logic in that service was touched.

## 4. Video certification ownership check

`StaffApplicant` has no `user_id` column (self-registration links `users` →
`employees`, not → `staff_applicants` — see the original audit's note on this).
Ownership for a STAFF-role caller is resolved by phone match: the JWT's `phone`
claim must equal the target `staff_applicant.mobile`. Applied to
`upload-url`, `finalize`, `register`, and `list/:staffId` — the endpoint the audit
specifically proved was IDOR-able. `getPrompts` stays reference-data-only (STAFF,
RM, BM, ADMIN); `view-url` and `verify-hash` are reviewer/system operations
(RM/BM/ADMIN, or STAFF+RM+ADMIN for the upload-finalize step) per the spec's Pillar
5 role list.

## 5. Public endpoints re-verified reachable

`/` (root ping), `/api/v1/health`, and `/finance/settlements/webhook` (Razorpay
cannot send a Bearer token) are explicitly `@Public()` and confirmed still
reachable with no token. The webhook still has **no signature verification** —
unchanged from before, flagged as a residual gap below, not fixed here since it's
correctness/integration work, not an authorization boundary.

---

## Before vs After (live-tested)

| Finding | Before | After |
|---|---|---|
| STAFF advances FSM | 200 (reached S5_DEPLOY) | **403** |
| CLIENT advances FSM | allowed | **403** |
| FINANCE advances FSM | allowed | **403** |
| BM advances FSM (read-only role) | allowed | **403** |
| Finance reads staff pipeline (`GET /staff`) | 200 | **403** |
| Staff reads payroll | 200 | **403** |
| Client reads payroll | 200 | **403** |
| Staff triggers DL verification | 201 | **403** |
| Client triggers DL verification | 201 | **403** |
| Finance triggers DL verification | 201 | **403** |
| Client lists video certs | 200 | **403** |
| Staff reads another staff's video certs (IDOR) | 200 | **403** |
| STAFF/CLIENT/RM/FINANCE write restricted list | reached service (500, no authz check) | **403** (STAFF/CLIENT/FINANCE), **403** RM (read-only) |
| Forged `added_by` in restricted-list body | accepted verbatim | **ignored — real JWT actor persisted** |
| `assessments`/`competency`/`driver-tests`/`schedules` | no auth at all | **401** with no token, **403** for wrong role |
| RM triggers DL verification | — | 201 (unchanged, still works) |
| BM writes restricted list | — | 201 (unchanged, still works — plus the pre-existing 500 bug is now also fixed) |
| Finance dashboard / payroll / invoices / analytics | — | 200 for RM/BM/FINANCE/ADMIN (unchanged) |
| RM/BM staff listing, branch scoping | — | Untouched — RM-A/RM-B branch split still intact (not re-verified numerically this pass since it wasn't touched by any Phase 1 edit, but no code path affecting it was modified) |
| Admin platform-wide access | — | 200 across `/staff`, `/finance/payroll`, `verification/dl`, `/admin/users` |
| `/auth/me`, logout, 2FA, register, login, refresh, health, root | — | All still 200/expected for every role, and public ones reachable with no token |

## Remaining known issues (explicitly NOT touched in Phase 1)

- **Self-registration spec conflict** — `register/customer` / `register/staff` remain
  public and unchanged, per instruction not to silently remove them. Flagged with a
  code comment at the call site. **Needs a product decision before Phase 2.**
- **DB append-only** — `pipeline_events`/`admin_audit_logs` triggers still not
  applied; app still connects as `postgres` superuser. Untouched (Phase 2).
- **Token revocation** — deactivating a user or calling `logout-all` still doesn't
  invalidate an already-issued access token (`JwtStrategy.validate()` doesn't hit
  the DB). Untouched (Phase 2).
- **Finance calculation issues** — GST-on-whole-cost bug in the commercial
  calculator, the five divergent payroll engines, ESIC/PF ceiling gaps. Untouched
  (Phase 3), and explicitly not touched here.
- **Deployment gates / scenario routing disconnect** — `S4→S5` still has no
  liability-pillar predicate; `routeScenario()` still isn't called from
  `advanceStage()`. **Now that unauthorized roles can no longer reach the FSM at
  all, this gap is far less exploitable** (only RM/Admin can trigger it, matching
  the trusted-operator assumption the rest of the pipeline is built on) — but the
  gate itself is still absent and belongs to Phase 3.
- **Series enum mismatch** (`SC`/`UC`/`DR` vs `SKILLED_CARE`/`UNSKILLED_CARE`/`DRIVER`)
  — untouched, still breaks 3 of 4 video-prompt lookups when a DB-shaped series
  string is passed in.
- **Razorpay webhook has no signature verification** — had to stay `@Public()` for
  Razorpay to reach it; this was already true before Phase 1 and is now just
  explicit instead of accidental. Real fix (HMAC signature check against Razorpay's
  webhook secret) is a payment-integration correctness task, not authorization.
- **Mobile apps, liability pillars 6–9, real SMS/WhatsApp providers, notification
  recipient fan-out, trial/exit/upgrade flows, the 7 zero-route stub controllers**
  — all confirmed still absent, all Phase 4 per the original audit.

## Verification method

Fresh JWTs obtained live for all 6 roles (ADMIN via a programmatically-generated
TOTP code from the seeded secret). Ran the full attack matrix (wrong role → must be
403/401) and full regression matrix (right role → must still work) against a
locally running instance after a clean restart, confirmed via `npx tsc --noEmit`
(zero errors) and the server boot log (zero DI/route errors). All test users,
restricted-list entries, and linked records created for testing were deleted
afterward and verified at zero leftover rows.

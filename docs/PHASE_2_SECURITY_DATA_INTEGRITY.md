# Phase 2 Implementation Report

Database-level append-only protection, application DB privilege reduction, and
real token/session revocation — the four Phase 2 findings (C5–C8) from the
2026-08-10 audit. No payroll/GST/PF/ESIC logic touched, no FSM topology
changed, no mobile apps, no liability pillars, no scenario routing. Phase 1
authorization re-verified intact at the end.

---

## 1. Changes Made

| File | Why |
|---|---|
| [prisma/apply-triggers.ts](prisma/apply-triggers.ts) | Unchanged — reused as-is for local dev (`npm run db:apply-triggers`... see below, actually wired via the new plain-JS script instead, see next row) |
| [scratch/apply_security_triggers.js](scratch/apply_security_triggers.js) | **New.** Plain JS + `pg` (a real prod dependency) version of the trigger-application logic. `apply-triggers.ts` needs `ts-node`, which is a devDependency and doesn't exist in the slim production Docker image (`npm ci --only=production`) — this is why the trigger was never actually applied in production despite the migration file existing. Runs independently of Prisma's migration state tracking, which is why it works regardless of the `20260528000000_admin_security_triggers` migration being marked rolled-back. |
| [scratch/render_start.sh](scratch/render_start.sh) | Added a call to `apply_security_triggers.js` right after `prisma migrate deploy` — this is the **actual** Docker/Render production entrypoint (`Dockerfile`'s production `CMD`), not the `render:start` npm script, which is a separate/older path. |
| [package.json](package.json) | `start`, `start:prod`, `render:start` now all run `scratch/apply_security_triggers.js` after `db push`, so the trigger survives every deploy path, not just the one I happened to test. Added `db:apply-triggers` as a standalone script. |
| [scratch/setup_app_db_role.sql](scratch/setup_app_db_role.sql) | **New.** Documented, reusable SQL for creating the restricted role on another environment (staging, a fresh DB) — not auto-run anywhere, reference only. |
| [src/modules/auth/strategies/jwt.strategy.ts](src/modules/auth/strategies/jwt.strategy.ts) | `validate()` now queries `users.isActive` and `users.activeSessionId` on every request and rejects if the account is deactivated or the token's `sid` no longer matches the DB's current session. This is the actual fix for C7/C8 — previously nothing after token issuance ever touched the DB again. |
| [src/modules/auth/auth.service.ts](src/modules/auth/auth.service.ts) | `refreshTokens()` now selects `active_session_id` and includes it as `sid` in the reissued access token payload. Without this, every refreshed token would have `sid: undefined` and immediately fail the new check in `jwt.strategy.ts` — this was needed to avoid breaking the refresh flow, not a standalone fix. |
| `.env` | `DATABASE_URL` now points to `homegenny_user` (restricted, non-superuser) instead of `postgres`. |
| DB: role `homegenny_user` created; ownership of all 83 tables + 11 functions transferred to it | See §2. |

## 2. Database Security

**Append-only trigger** — reused the existing `prevent_update_delete()` function and `BEFORE UPDATE OR DELETE` triggers on `pipeline_events` and `admin_audit_logs` exactly as already defined in `prisma/apply-triggers.ts` / the `20260528000000_admin_security_triggers` migration (per instruction, repaired rather than duplicated). The problem was never the SQL — it's correct — it was that nothing in any real deploy path ever executed it. Fixed by wiring `apply_security_triggers.js` into every path (§1).

**Verified via `pg_catalog`** (not just "the migration file exists"):
```
table_name        | trigger_name                              | tgenabled
pipeline_events    | prevent_update_delete_pipeline_events     | O  (enabled)
admin_audit_logs   | prevent_update_delete_admin_audit_logs    | O  (enabled)
```

**Application DB role:**
```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname='homegenny_user';
```
```
rolname          | rolsuper | rolcreatedb | rolcreaterole | rolreplication | rolbypassrls
homegenny_user    | false    | false       | false         | false          | false
```
Confirmed via `pg_stat_activity` that every currently active connection to the `homegenny` database — including the running application, not just my test scripts — is `homegenny_user`. Zero `postgres` connections.

**`pipeline_events` behavior under the app's actual runtime role:**

| Operation | Result |
|---|---|
| INSERT | **SUCCESS** |
| UPDATE | **DENIED** — `Table is append-only. Modification or deletion is not allowed.` (from the DB) |
| DELETE | **DENIED** — same, from the DB |

Tested three ways: (1) in a rolled-back transaction as the original `postgres` superuser, before the role switch — confirms the trigger fires regardless of role, including superuser; (2) as `homegenny_user` post-switch, in a rolled-back transaction; (3) against a **real, non-test row** created through the actual FSM API by an authorized RM — see §4 below.

### Design choice: ownership-based role, not a split migration/runtime role

I initially planned two roles (a privileged migration-only role + a stripped-down runtime role with no DDL rights), but the codebase has **three** places that run idempotent DDL (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`) through the app's own normal runtime connection at every startup — `SchemaBootstrapService`, `FinanceCustomerService.ensureTablesExist()`, and `render_pre_migrate.js`. Stripping DDL from the runtime role would break all three (a Phase 2 failure condition: "normal authorized workflows are broken"). Postgres `ALTER TABLE` requires table ownership, not just a grant, so I made `homegenny_user` the owner of its own schema instead.

This means the append-only guarantee is **not** privilege-based (`REVOKE UPDATE, DELETE` would be meaningless against an owning role, since owners can always re-grant themselves privileges on objects they own — that's not a real boundary). It's entirely the trigger. This was deliberately verified: the trigger rejects UPDATE/DELETE from `homegenny_user` even though `homegenny_user` owns `pipeline_events` outright.

`REASSIGN OWNED BY postgres TO homegenny_user` (the normal bulk command) does not work here — Postgres refuses it with *"cannot reassign ownership of objects owned by role postgres because they are required by the database system"* on the bootstrap role. Ownership was transferred table-by-table/function-by-function instead (script used, not committed; the reusable pattern is in `scratch/setup_app_db_role.sql`).

**Also verified real application behavior, not just role flags:** the app was restarted from scratch under the new role and confirmed to boot cleanly — `SchemaBootstrapService`'s DDL bootstrap succeeded, all normal CRUD works, and `npx prisma db push` (used by `start`/`start:prod`) was confirmed to have sufficient privileges to run under this role (tested safely without `--accept-data-loss`, so nothing was actually altered — see §5, "Remaining Issues," for why that flag wasn't exercised).

## 3. Token Revocation

| Scenario | Expected | Actual | Status |
|---|---|---|---|
| Active token, `GET /auth/me` | 200 | 200 | ✅ |
| Deactivated user (`is_active=false`) + old token, `GET /auth/me` | 401 | 401 | ✅ |
| Same deactivated-user token, a *different* protected endpoint (`/video-cert/prompts/MAID`) | 401 | 401 | ✅ |
| `POST /auth/logout-all` + same old access token reused | 401 | 401 | ✅ |
| New login after logout-all | 200 | 200 | ✅ |
| Device A login → Device B login (single active session) → Device A's token reused | 401 | 401 | ✅ |
| Device B's token (the currently active session) | 200 | 200 | ✅ |
| No token / malformed token / garbage token | 401 | 401 | ✅ |
| `POST /auth/refresh` with a valid refresh token → reissued access token | 200 (must still work — `sid` must carry over) | 200 | ✅ |
| Admin TOTP login + 8-hour session wall, with the new per-request DB check layered on top | Unaffected | `requires_2fa`/token issuance unchanged, `/auth/me` and `/admin/users` both 200 with a valid admin token | ✅ |

All confirmed live against the running instance, not inferred from code review.

**Mechanism:** `JwtStrategy.validate()` now does one `SELECT isActive, activeSessionId FROM users WHERE id = ...` per authenticated request (cheap — indexed PK lookup) and rejects if the user is inactive or if the token's `sid` claim doesn't match the DB's current `active_session_id`. `login()` already generated a fresh `sid` per login and stored it as `active_session_id`; `logout()`/`logoutAllDevices()` already cleared `active_session_id` to `NULL`. Both were already correct — the only actual gap was that nothing ever checked them again after the initial JWT verification. The single code change needed beyond the strategy itself was making `refreshTokens()` propagate the current `sid` into the reissued token, since it previously omitted it entirely (a latent bug that would have broken refresh the moment the new check went live).

## 4. Audit Log Integrity (real workflow, not synthetic)

An RM logged in normally and called `POST /pipeline/:staffId/advance` through the actual API (not a direct DB write) to move a test applicant `S1_INTAKE → S2_VERIFY`:

```json
{
  "event_type": "STAGE_ADVANCE",
  "from_stage": "S1_INTAKE",
  "to_stage": "S2_VERIFY",
  "actor_id": "bd00eb2b-...",
  "reason_code": "phase2-audit-test",
  "occurred_at": "2026-08-10T06:46:03.021Z"
}
```
`actor_id` confirmed to exactly match the authenticated RM's real user ID (no spoofing possible — the FSM controller has always taken this from `req.user.id`, untouched in Phase 2). Immediately after creation, both `UPDATE` and `DELETE` against this **real, legitimately-created** row were attempted and both rejected by the database with the append-only error. The row is still present, unmodified.

One side effect worth flagging: this test row (and its parent `staff_applicants` test record, `staff_code = 'P2-AUDIT-001'`) **cannot be cleaned up** — `pipeline_events.staff_id` has a foreign key back to `staff_applicants`, and since the event row is now permanently immutable, its parent can't be deleted either (FK violation). This is the append-only guarantee working exactly as intended, not a bug — I did not attempt to bypass it for cleanup convenience, since doing so would contradict the entire point of the fix. Both rows are clearly named/labeled as test artifacts and are harmless.

## 5. Phase 1 Regression

Re-ran the full Phase 1 attack matrix and regression matrix against the final Phase 2 configuration with fresh tokens for all six roles:

| Check | Result |
|---|---|
| STAFF/CLIENT/FINANCE pipeline advance | 403 (unchanged) |
| STAFF verification/dl | 403 (unchanged) |
| CLIENT finance/payroll | 403 (unchanged) |
| FINANCE `GET /staff` | 403 (unchanged) |
| CLIENT video-cert list | 403 (unchanged) |
| RM restricted-list **write** (read-only role) | 403 (unchanged) |
| RM `GET /staff`, RM verification/dl | 200/201 (unchanged) |
| BM restricted-list **add** | 201 (unchanged) |
| FINANCE finance/payroll | 200 (unchanged) |
| ADMIN `GET /staff`, `GET /admin/users` | 200/200 (unchanged) |

Zero regressions. Phase 1's authorization layer and Phase 2's session/DB layer are independent and compose cleanly — RolesGuard/JwtAuthGuard decide *what* a role can do; the new JwtStrategy check decides *whether the token is still good at all*, before authorization is even evaluated.

## 6. Remaining Issues (explicitly not touched — Phase 3/4)

- **GST/PF/ESIC calculation bugs**, the five divergent payroll engines — untouched.
- **FSM deployment gates / scenario routing disconnect / series enum mismatch** — untouched. (Phase 1's authorization fix already means only RM/Admin can reach the FSM at all, which reduces exposure, but the gate itself is still absent.)
- **Self-registration spec conflict** — still public, still flagged, still unresolved pending your product decision.
- **`db push --accept-data-loss` was not exercised against the new role** — I confirmed the role has sufficient privileges to get through Prisma's schema diff (safe, without the flag), but did not run the destructive apply, because the diff surfaces the *same* pre-existing, unrelated schema drift (`finance_customers.city/state/pincode`, `finance_wage_config` columns, `finance_customer_branches` table) that was already found and deliberately left alone earlier — running `--accept-data-loss` again would re-touch that, which is out of Phase 2's scope and something you already told me to leave as-is.
- **Razorpay webhook signature verification** — still absent (Phase 1 report), unrelated to Phase 2.
- **Mobile apps, liability pillars 6–9, SOW, client indemnity, right-to-refuse, incident trail, real SMS/WhatsApp providers, cron consolidation, trial/exit/upgrade flows** — all still absent, all later phases, per the original audit.
- **`.env.production`** does not exist in this repository (Render/production env vars are configured on the platform, not committed) — so there was nothing to update there. If production currently uses a `postgres`-based `DATABASE_URL` set directly in Render's dashboard, that value needs to be swapped to a `homegenny_user`-equivalent role **created on the production database** using `scratch/setup_app_db_role.sql` as a reference — this was not done for you, since I have no access to the production database, and creating a production role/rotating production credentials without your direct involvement would be well outside what I should do unilaterally.

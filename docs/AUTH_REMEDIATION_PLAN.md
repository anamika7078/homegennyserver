# Auth Remediation Plan (v3)
Date: 2026-09-16 · Scope: login, logout, session, token refresh (web + mobile + API)

## Fixed product decisions (do not re-litigate)
1. Demo accounts + password stay visible on the public login page, behind
   NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS. Password for all demo users: `hg`.
2. Password-reset OTP stays hardcoded `123456` until an SMS provider exists.
The plan below is built around both, not against them.

## Measured on prod, 2026-09-16
| Path | Time | Note |
|---|---|---|
| /auth/login page HTML | 0.5-1.6s | fixed (prod build) |
| POST /auth/login, unknown phone | 0.36s | DB lookup is fine |
| POST /auth/login, real phone + wrong password | 6.2-7.3s | bcrypt.compare alone |
| /api/v1/health | 0.5s | backend reachable |
| logout (authenticated) | 5-10s est. | 401 -> refresh(bcrypt) -> retry -> 2x guard |
bcryptjs async cost 12 = 331ms locally; 5 parallel = 1.85s. Prod ~6s = slow vCPU
plus a busy event loop (nest --watch + TypeORM query logging).

## Status — 2026-09-16

Phase 1 and 3.1 are WRITTEN AND TESTED LOCALLY, not yet deployed. 14/14 end-to-end
checks pass against a local build (two devices, refresh, logout, forgery).
Measured locally: login 473ms; three concurrent logins 843ms total; logout 18ms.

Two further bugs surfaced while building this and are fixed in the same batch:
  - Two logins to the same account within one second produced byte-identical
    refresh tokens (payload was {sub, loginAt}, loginAt in whole seconds), so one
    token covered two sessions and signing out of one left the other usable.
    Refresh tokens now carry their session id.
  - The legacy admin logout (admin.service.logout) cleared only the old user
    columns, which no longer end a session now that auth reads user_sessions.

## Phase 0 - done
Frontend production build; demo block moved behind a build flag.

## Phase 1 - speed (day 1) — DONE locally, awaiting deploy
1.1 bcryptjs -> @node-rs/bcrypt (native, prebuilt). Same $2a/$2b format, cost 12,
    no password resets needed. Files: auth.service, user-provisioning,
    admin.service, portal-users.seed, users.seed.
1.2 Refresh token: drop bcrypt, use sha256 + jwt.verify() + timingSafeEqual.
    Also closes the 72-byte forgery hole. MUST ship with 3.1.
1.3 Backend production mode: node dist/main, NODE_ENV=production,
    TYPEORM_SYNCHRONIZE=false, SQL logging driven by database.logging not app.env.
1.4 Logout non-blocking: clear local state + redirect first, fire API in
    background; never run the refresh-retry for /auth/logout.
1.5 Logout accepts an expired access token (verify signature, ignore exp) so the
    session row always gets cleared.

## Phase 2 - per-request overhead (day 2)
2.1 app.set('trust proxy', 1) - today the 5/min login limit is ONE bucket for the
    whole site, and every login_audit row records the proxy IP.
2.2 Remove duplicate @UseGuards(JwtAuthGuard) from 56 controllers (global guard
    already runs) - saves one DB query + one passport run per request.
2.3 Merge the extra `SELECT metadata` into validateUser; index lower(email) and
    staff_applicants.mobile.
2.4 Cache role permissions (5 min).

## Phase 3 - session model (day 3) — 3.1 DONE locally, 3.2-3.4 open
3.1 user_sessions table: one row per device (session id + hashed refresh token).
    Required because demo accounts are shared - single active_session_id logs
    demo users out of each other's sessions, and fixing 1.2 removes the accident
    that currently masks it. Also lets real staff use phone + web together.
3.2 Web: single-flight refresh. Today the 2nd concurrent 401 calls
    tokenStore.clear() and redirects to login (client.ts:106). The Flutter app
    already does this correctly (_refreshFuture) - copy that.
3.3 Access token 15m -> 30-60m (revocation is checked per request anyway).
3.4 Zustand persist; socket reconnect after token expiry; one socket module.

## Phase 4 - security within the two constraints (with Phase 1)
4.1 jwt.verify() + constant-time compare on /auth/refresh (comes with 1.2).
4.2 Two-layer throttle: per IP (needs 2.1) AND per account. A public password
    makes IP-only limits insufficient.
4.3 OTP stays 123456, but contained - none of this needs SMS:
    - put it behind an explicit AUTH_MOCK_OTP flag so it cannot ship silently
    - throttle forgot-password / verify-otp / reset-password (they have NO
      throttle today - that is the real multiplier)
    - limit the public reset path to demo numbers; real users get an
      Admin-set temporary password + mustChangePassword (flow already exists)
    - audit-log every mock-OTP use at warn level
4.4 Demo data safety: block destructive actions (delete / disburse / payout) for
    demo accounts, or reset demo data nightly. 9800000003 is a full Admin.
4.5 Stop storing the plain-text password in sessionStorage on the 2FA page.

## Phase 5 - cleanup / later
- Email OTP when ready: nodemailer + SMTP config already exist, only SMTP_PASS is
  missing. Works without any SMS provider.
- change-password mock OTP; dead staff self-registration endpoint;
  /auth/me vs /user/profile duplication.

## Deployment note
NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS must be passed as a Docker build arg. A compose
`environment:` entry will not work - NEXT_PUBLIC_* is baked at build time.

## Verification after each phase
login  : < 1s (today 6.2s)
logout : < 0.3s, and 200 even with an expired token
limit  : 5 attempts from two different IPs stay independent
demo   : same demo account in two browsers - both stay logged in

## Deploy order for what is built (Phase 1 + 3.1)
1. npm install on the backend — @node-rs/bcrypt is a new dependency.
2. node scratch/_a1_user_sessions_migration.js  (additive; do NOT use
   `prisma db push` on prod — it diffs the whole schema. Note that the
   `start`/`start:prod` npm scripts DO call db push; that predates this work
   but is worth removing before the next prod deploy.)
3. Rebuild the backend image on the production target, with NODE_ENV=production,
   TYPEORM_SYNCHRONIZE=false, and DB_LOGGING unset.
4. Rebuild the frontend with its build args, NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS
   included if the demo block should be visible.
5. Verify with the numbers in the section above.

Rollback: the old columns are still written, bcryptjs still reads every hash this
build writes, and user_sessions is additive — the previous image runs unchanged.
Sessions created by the new build keep working; their refresh tokens do not, so
those users log in once more.

---

# Progress log — 2026-09-16 (second session)

## Done and tested locally
Phase 1 (1.1-1.5), Phase 2 (2.1-2.4), Phase 3 (3.1-3.4), Phase 4 (4.1-4.3, 4.5).

Phase 2
  2.1 trust proxy: app.set('trust proxy', 1) in main.ts, app typed as
      NestExpressApplication. The login throttle becomes per client instead of
      one bucket for the whole site, and login_audit records real addresses.
  2.2 61 duplicate @UseGuards(JwtAuthGuard[, RolesGuard]) declarations removed
      from 56 controllers; both guards are global APP_GUARDs and were running
      twice per request. Re-verified after removal: every protected route still
      answers 401 without a token, and an RM token still gets 403 on admin
      routes. (Unused guard imports were left in place — cosmetic only.)
  2.3 findUserByIdentifier(): decides email vs phone first instead of ORing
      phone against LOWER(email) in one statement, which no index could serve.
      login() no longer re-queries the metadata column validateUser just read.
      Indexes added by scratch/_a2_auth_indexes_migration.js; both lookups
      confirmed to use an Index Scan.
  2.4 Role permissions cached for 60s; seedPermissions() clears the cache.

Phase 3
  3.2 Single-flight token refresh on the web client. Concurrent 401s now wait
      on one /auth/refresh instead of the second one calling tokenStore.clear()
      and redirecting to the login page — the "logged out every 15 minutes"
      behaviour.
  3.3 Access token 15m -> 30m (JWT_EXPIRES_IN). Revocation is per-request, so
      the short window bought nothing. ADMIN stays at 8h with its session wall.
  3.4 Auth store persisted (identity only, not tokens; isAuthenticated stays
      derived from the token). Both socket modules reconnect after a
      server-side disconnect, and the realtime one stops opening a second
      socket while the first is still connecting.

Phase 4
  4.2 Per-account attempt limiting: 10 failures per account+address per 15 min,
      cleared by a successful sign-in. Keyed by account AND address on purpose
      so one person cannot lock a shared demo account for everyone.
  4.3 Fixed OTP kept, but contained: it now comes from AUTH_MOCK_OTP (default
      123456, set to "off" to disable), every use is logged at warn level, and
      forgot-password / verify-otp / reset-password are throttled to 3 per 15
      min per address — they had no limit at all before. /auth/refresh is
      throttled at 30/min.
  4.5 The 2FA step no longer writes the plain-text password to sessionStorage;
      it is held in memory for the one navigation and dropped on reload.

## Verified
  - 14/14 end-to-end auth checks (two devices, refresh, logout, forgery).
  - Authorization unchanged after the guard cleanup: 7 protected routes answer
    401 unauthenticated, RM token gets 403 on admin routes, 200 on its own.
  - Account lockout fires on the 11th failure and does not affect other
    accounts; reset endpoint returns 429 on the 4th attempt.
  - Both builds pass; frontend shared JS 87.6 kB.

## Still open
  4.4 Demo-account safety (blocking destructive actions for the public demo
      logins, or a nightly data reset) — needs a product decision about what a
      demo user is allowed to do, so it is deliberately not implemented.
  Phase 5 Email OTP once SMTP_PASS exists; a real 2FA challenge token so the
      password is not re-sent at the 2FA step; the dead staff self-registration
      endpoint; /auth/me vs /user/profile duplication.

## 4.4 — decided, not doing (2026-09-17)
Demo-account safety is deliberately skipped. The owner's call: this is a demo
environment and the data in it does not matter, so the public demo logins keep
full access, destructive actions included. Revisit before any real client data
lives on this server — at that point either drop the demo block from the login
page or restrict what those accounts can do.

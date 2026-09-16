-- Additive: one row per signed-in device, instead of one session per account.
--
-- `users.active_session_id` / `users.refresh_token_hash` hold exactly ONE
-- session, so signing in anywhere silently ended the session everywhere else:
-- the next request from the older device failed JwtStrategy's sid check. Two
-- people sharing the demo accounts printed on the login page, or one staff
-- member using the mobile app and the web portal, could not both stay signed
-- in. (Until now a bug hid this: the refresh endpoint compared bcrypt hashes,
-- which stop at 72 bytes, so an evicted device could refresh itself back in
-- using the *new* session's id. Closing that hole makes the single-session
-- limit visible, so this has to land in the same deploy.)
--
-- Nothing is dropped. The old columns stay and keep being written, so a
-- rollback to the previous build still finds the session it expects.
CREATE TABLE IF NOT EXISTS user_sessions (
    id                 UUID PRIMARY KEY,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(128) NOT NULL,
    ip_address         VARCHAR(64),
    user_agent         VARCHAR(400),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user       ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_hash       ON user_sessions (refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions (expires_at);

-- Carry the one session each user currently has into the new table, so access
-- tokens already in people's browsers keep validating after the deploy instead
-- of everyone being signed out at once. Their refresh tokens are still bcrypt
-- hashes and will not match the new digest, so those sessions end when the
-- access token expires — minutes, not instantly, and only once.
INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at)
SELECT u.active_session_id::uuid,
       u.id,
       COALESCE(u.refresh_token_hash, 'migrated-no-refresh'),
       CURRENT_TIMESTAMP + INTERVAL '7 days'
  FROM users u
 WHERE u.active_session_id IS NOT NULL
   AND u.active_session_id ~ '^[0-9a-fA-F-]{36}$'
ON CONFLICT (id) DO NOTHING;

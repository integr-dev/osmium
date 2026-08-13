-- Tells the person it happened to.
--
-- When a refresh token is replayed, every session in that family is revoked and the incident is
-- written to the audit trail — which needs `audit.read`, so an administrator sees it and the account
-- it actually happened to does not. A viewer whose session was taken is simply signed out, and reads
-- that as the app having glitched.
--
-- There is no channel to reach them on: no email, no push, nothing out of band. So the account
-- carries the notice and the interface shows it the next time they sign in. It cannot be shown at
-- the login screen — before authentication that would confirm both that a username exists and that
-- something happened to it.
ALTER TABLE users
    -- When a replay was last detected. Null for the overwhelming majority of accounts.
    ADD COLUMN session_alert_at TIMESTAMPTZ,
    -- When the operator acknowledged it. Older than the alert, or null, means it is still unread —
    -- kept rather than clearing the alert itself so the trail of "this happened" survives the
    -- dismissal of "and you were told".
    ADD COLUMN session_alert_seen_at TIMESTAMPTZ;

-- Refresh tokens, so the browser stops holding a long-lived credential where JavaScript can read it.
--
-- The access token is still a Bearer header and still short-lived; what changes is that it now lives
-- only in the tab's memory, and is re-minted from a refresh token kept in an HttpOnly cookie.
--
-- Rows rather than a stateless token, because the two properties that make a long-lived credential
-- defensible both need server-side state: a token can be revoked before it expires, and presenting
-- one that has already been rotated is evidence of theft.
CREATE TABLE refresh_tokens (
    id         BIGSERIAL PRIMARY KEY,

    -- SHA-256 of the token, never the token. A leaked database therefore yields no usable session.
    -- Not BCrypt: this is 32 bytes of CSPRNG output rather than a password, so there is nothing to
    -- brute-force and no reason to pay a work factor on every refresh. BCrypt would also silently
    -- truncate at 72 bytes.
    token_hash VARCHAR(64)  NOT NULL UNIQUE,

    user_id    BIGINT       NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- Every token minted from one login shares a family. Rotation issues a successor in the same
    -- family, so when a stolen token is replayed the whole chain descended from that login can be
    -- revoked at once - including the one the thief or the victim is currently holding.
    family     UUID         NOT NULL,

    issued_at  TIMESTAMPTZ  NOT NULL,

    -- Inherited unchanged by every successor: the session expires a fixed span after the login that
    -- started it, and refreshing does not extend it. An operator signs in again on that schedule
    -- whether or not they have been active.
    expires_at TIMESTAMPTZ  NOT NULL,

    -- When this token was exchanged for its successor. A second presentation of a token that
    -- already has one is the reuse signal - the legitimate holder never replays.
    used_at    TIMESTAMPTZ,

    -- Set on logout, and on every token in a family when reuse is detected.
    revoked_at TIMESTAMPTZ
);

-- The lookup on every refresh is by hash; UNIQUE above already indexes it.
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (family);
-- The daily purge scans by expiry.
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);

-- Adds SESSION_REUSE_DETECTED to the audit action enum. Hibernate emits the allowed values as a
-- CHECK constraint rather than a Postgres enum type, so a new constant is a schema change; there is
-- no ALTER for a check constraint, so it is dropped and rewritten in full. See V3.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

ALTER TABLE audit_entries
    ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
        'AGENT_CREATE', 'AGENT_UPDATE', 'AGENT_DELETE', 'AGENT_SETUP', 'AGENT_CONNECT',
        'AGENT_DISCONNECT', 'AGENT_CHAT',
        'HOST_ENROL', 'HOST_RENAME', 'HOST_ROTATE_TOKEN', 'HOST_DELETE',
        'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_ROLE_CHANGE', 'USER_PASSWORD_CHANGE',
        'AUDIT_EXPORT',
        'SESSION_REUSE_DETECTED'
    ));

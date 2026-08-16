-- Makes a compromised session something an operator can actually do something about.
--
-- Two problems, both of which needed state that did not exist.
--
-- **An access token could not be revoked.** It is a stateless JWT, so nothing on the server knew it
-- had been issued: deleting or renaming the account killed it, but changing a password did not, and
-- there was no way at all to end a session without also ending the account.
--
-- A counter rather than a "valid from" timestamp, which is what this started as. A JWT's `iat` is
-- whole seconds, so a timestamp cutoff has to choose which way to round and both are wrong: round
-- down and a token issued earlier in the same second survives revocation, round up and signing
-- straight back in rejects the token it just minted. A version has no such edge - it is issued into
-- the token, compared exactly, and incremented to revoke - and it is checked inside the
-- authorization query that already runs on every request.
ALTER TABLE users
    ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- **A session could not be recognised.** A list of sessions is only useful if the operator can tell
-- which one is theirs and which is the one they do not recognise, and nothing was recorded to tell
-- them apart. Both are nullable: they are whatever the request happened to carry, and inventing a
-- value would be worse than admitting it is unknown.
--
-- These are personal data, and deliberately short-lived: refresh tokens are purged once expired, so
-- an address outlives its session by at most a day. Nothing else in Osmium retains them.
ALTER TABLE refresh_tokens
    ADD COLUMN client_ip VARCHAR(45),
    ADD COLUMN user_agent VARCHAR(255);

-- Listing an account's live sessions filters on the owner and skips spent and revoked links.
CREATE INDEX idx_refresh_tokens_user_live ON refresh_tokens (user_id, issued_at DESC);

-- Adds SESSION_REVOKED_ALL. As in V3 and V4, Hibernate emits the allowed values as a CHECK
-- constraint, and there is no ALTER for one, so it is dropped and rewritten in full.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

ALTER TABLE audit_entries
    ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
        'AGENT_CREATE', 'AGENT_UPDATE', 'AGENT_DELETE', 'AGENT_SETUP', 'AGENT_CONNECT',
        'AGENT_DISCONNECT', 'AGENT_CHAT',
        'HOST_ENROL', 'HOST_RENAME', 'HOST_ROTATE_TOKEN', 'HOST_DELETE',
        'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_ROLE_CHANGE', 'USER_PASSWORD_CHANGE',
        'AUDIT_EXPORT',
        'SESSION_REUSE_DETECTED', 'SESSION_REVOKED_ALL'
    ));

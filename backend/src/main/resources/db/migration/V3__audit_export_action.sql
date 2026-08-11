-- Adds AUDIT_EXPORT to the audit action enum.
--
-- Hibernate emits the allowed values as a CHECK constraint rather than a Postgres enum type, so a
-- new constant is a schema change: without this, inserting one fails against the stale list. There
-- is no ALTER for a check constraint, so it is dropped and rewritten in full.
--
-- The name matches what Hibernate generated in the baseline. `IF EXISTS` covers a database that
-- predates the named constraint.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

ALTER TABLE audit_entries
    ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
        'AGENT_CREATE', 'AGENT_UPDATE', 'AGENT_DELETE', 'AGENT_SETUP', 'AGENT_CONNECT',
        'AGENT_DISCONNECT', 'AGENT_CHAT',
        'HOST_ENROL', 'HOST_RENAME', 'HOST_ROTATE_TOKEN', 'HOST_DELETE',
        'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_ROLE_CHANGE', 'USER_PASSWORD_CHANGE',
        'AUDIT_EXPORT'
    ));

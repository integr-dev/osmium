-- Adds STORAGE_PURGE to the audit action enum.
--
-- Hibernate emits the allowed values as a CHECK constraint rather than a Postgres enum type, so a
-- new constant is a schema change: without this, inserting one fails against the stale list. There
-- is no ALTER for a check constraint, so it is dropped and rewritten in full.
--
-- This is the one action whose point is that records stop existing, which makes the trail line the
-- only thing left afterwards. It is also why the trail is not something the purge can be aimed at.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

ALTER TABLE audit_entries
    ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
        'AGENT_CREATE', 'AGENT_UPDATE', 'AGENT_DELETE', 'AGENT_SETUP', 'AGENT_SETUP_CANCEL',
        'AGENT_CONNECT', 'AGENT_DISCONNECT', 'AGENT_CHAT', 'AGENT_INVENTORY',
        'HOST_ENROL', 'HOST_RENAME', 'HOST_ROTATE_TOKEN', 'HOST_DELETE',
        'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_ROLE_CHANGE', 'USER_PASSWORD_CHANGE',
        'AUDIT_EXPORT', 'STORAGE_PURGE',
        'SESSION_REUSE_DETECTED', 'SESSION_REVOKED_ALL',
        'SCHEMATIC_UPLOAD', 'SCHEMATIC_RENAME', 'SCHEMATIC_DELETE',
        'BUILD_CREATE', 'BUILD_UPDATE', 'BUILD_DELETE',
        'BUILD_JOB_START', 'BUILD_JOB_PAUSE', 'BUILD_JOB_RESUME', 'BUILD_JOB_DELETE'
    ));

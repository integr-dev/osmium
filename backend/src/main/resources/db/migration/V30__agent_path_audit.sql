-- Adds AGENT_PATH to the audit action enum.
--
-- Hibernate emits the allowed values as a CHECK constraint rather than a Postgres enum type, so a
-- new constant is a schema change: without this, inserting one fails against the stale list. There
-- is no ALTER for a check constraint, so it is dropped and rewritten in full.
--
-- Sending an agent somewhere is audited for the same reason chat is: it acts in the world under an
-- account somebody owns, and where a bot walked is a question a server administrator may well ask
-- afterwards. The path itself is not recorded - it is planned on the host and is not the operator's
-- decision - but the destination they asked for is.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

ALTER TABLE audit_entries
    ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
        'AGENT_CREATE', 'AGENT_UPDATE', 'AGENT_DELETE', 'AGENT_SETUP', 'AGENT_SETUP_CANCEL',
        'AGENT_CONNECT', 'AGENT_DISCONNECT', 'AGENT_CHAT', 'AGENT_INVENTORY', 'AGENT_PATH',
        'HOST_ENROL', 'HOST_RENAME', 'HOST_ROTATE_TOKEN', 'HOST_DELETE',
        'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_ROLE_CHANGE', 'USER_PASSWORD_CHANGE',
        'AUDIT_EXPORT', 'STORAGE_PURGE',
        'SESSION_REUSE_DETECTED', 'SESSION_REVOKED_ALL',
        'SCHEMATIC_UPLOAD', 'SCHEMATIC_RENAME', 'SCHEMATIC_DELETE',
        'BUILD_CREATE', 'BUILD_UPDATE', 'BUILD_DELETE',
        'BUILD_JOB_START', 'BUILD_JOB_PAUSE', 'BUILD_JOB_RESUME', 'BUILD_JOB_DELETE'
    ));

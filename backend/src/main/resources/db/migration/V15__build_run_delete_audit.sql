-- Clearing a run out of the list, and therefore a third thing to record.
--
-- A cancelled or finished run is a record, and records accumulate: a plan rebuilt weekly leaves a
-- column of grey cards nobody reads. Removing one is allowed, and it is irreversible — the segments
-- and their last reported counts go with it — so it is recorded rather than being the one act on a
-- run that leaves no trace.
--
-- The start and the cancellation stay in the trail regardless, which is what makes this safe to
-- offer at all: deleting the row does not delete the history of what the fleet did.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

ALTER TABLE audit_entries
    ADD CONSTRAINT audit_entries_action_check CHECK (action IN (
        'AGENT_CREATE', 'AGENT_UPDATE', 'AGENT_DELETE', 'AGENT_SETUP', 'AGENT_SETUP_CANCEL',
        'AGENT_CONNECT', 'AGENT_DISCONNECT', 'AGENT_CHAT',
        'HOST_ENROL', 'HOST_RENAME', 'HOST_ROTATE_TOKEN', 'HOST_DELETE',
        'USER_CREATE', 'USER_UPDATE', 'USER_DELETE', 'USER_ROLE_CHANGE', 'USER_PASSWORD_CHANGE',
        'AUDIT_EXPORT',
        'SESSION_REUSE_DETECTED', 'SESSION_REVOKED_ALL',
        'SCHEMATIC_UPLOAD', 'SCHEMATIC_RENAME', 'SCHEMATIC_DELETE',
        'BUILD_CREATE', 'BUILD_UPDATE', 'BUILD_DELETE',
        'BUILD_RUN_START', 'BUILD_RUN_CANCEL', 'BUILD_RUN_DELETE'
    ));

-- A way out of SETUP_PENDING, and therefore a new thing to record.
--
-- Setup is open-ended by design: the backend hands the job to the host and has no visibility into
-- how far along a login is, so nothing can time it out the way a connect is timed out. But an
-- operator whose sign-in was never completed - wrong machine, closed terminal, expired device code -
-- had no way to say so. The agent stayed pending forever with its Set-up button disabled, which is
-- a dead end rather than a state.
--
-- Recorded apart from AGENT_SETUP because it is a different act. Nothing is sent to the host; the
-- backend simply stops asserting that a login is in progress. If the host completes it later, the
-- result still lands and still links the agent.
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
        'BUILD_CREATE', 'BUILD_UPDATE', 'BUILD_DELETE'
    ));

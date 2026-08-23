-- Cancelling becomes pausing, and one agent can hold only one segment.
--
-- **Cancel was a state nobody wanted.** It stopped a run and then sat there: the work could not be
-- picked up again, the record could not be acted on, and the only thing left to do with it was
-- delete it — which means the operator had to perform two acts to express one. Pause is the act
-- they were reaching for, and delete is what the other half of cancel already was.
--
-- So there are three states again, but they mean different things: ACTIVE is building, PAUSED is
-- stopped and resumable, DONE is finished. Nothing is unreachable and nothing is a dead end.

-- CANCELLED becomes PAUSED rather than DONE: a cancelled run was not finished, and calling it so
-- would claim a building that is not there. `finished_at` goes with it for the same reason — it was
-- written by an act that no longer exists, and the constraint below now says only a DONE run has one.
--
-- **Both constraints come off before the rows move.** A CANCELLED row becoming PAUSED with no
-- finishing time is exactly what the old pair forbade — non-ACTIVE meant finished — so updating
-- first fails on the constraint this migration exists to replace.
ALTER TABLE build_runs DROP CONSTRAINT build_runs_state_check;
ALTER TABLE build_runs DROP CONSTRAINT build_runs_finished_when_over;

UPDATE build_runs SET state = 'PAUSED', finished_at = NULL WHERE state = 'CANCELLED';

ALTER TABLE build_runs
    ADD CONSTRAINT build_runs_state_check CHECK (state IN ('ACTIVE', 'PAUSED', 'DONE'));

-- Only a finished run has a finishing time.
--
-- The previous version tied it to "not active", which was true while cancel was the only other
-- state. A paused run has not finished — it is stopped mid-way and will be resumed — so a time on
-- one would be a date attached to something that did not happen.
ALTER TABLE build_runs
    ADD CONSTRAINT build_runs_finished_when_done CHECK ((state = 'DONE') = (finished_at IS NOT NULL));

-- One live segment per agent, across every run.
--
-- Already refused by the service, in two places, with a message naming the agent. This is the
-- backstop: two requests assigning the same agent at the same moment each see a free agent, and
-- only the database sees both. An agent building two segments at once is not a display problem —
-- it is one bot walking between two sites placing half of each.
CREATE UNIQUE INDEX uq_build_segments_one_per_agent
    ON build_segments (agent_id) WHERE state IN ('ASSIGNED', 'BUILDING');

-- The trail follows the acts.
--
-- BUILD_RUN_CANCEL is rewritten rather than kept as a legacy value it would now be impossible to
-- record. That is a deliberate exception to this project's rule that the record outlives its
-- subject, and it is safe only because runs have never been released: the only rows that can exist
-- were written by the developer testing this feature today, and they describe the same act the new
-- constant names.

-- The constraint comes off before the rows move, for the reason the states above did: the value
-- being written is precisely the one the old list does not allow.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

UPDATE audit_entries SET action = 'BUILD_RUN_PAUSE' WHERE action = 'BUILD_RUN_CANCEL';

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
        'BUILD_RUN_START', 'BUILD_RUN_PAUSE', 'BUILD_RUN_RESUME', 'BUILD_RUN_DELETE'
    ));

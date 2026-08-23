-- A run becomes a job.
--
-- `run` was already taken. `agent.run` is the permission for operating the fleet, "running the
-- fleet" is what an operator does all day, and `BuildRun` sat beside both meaning something else
-- entirely — a unit of dispatched work. Job is the word for that and collides with nothing.
--
-- A rename rather than a rewrite of V14–V16, because those have already been applied: editing them
-- would fail the checksum on every database that has them, and the only thing that fixes is
-- throwing the database away.
ALTER TABLE build_runs RENAME TO build_jobs;
ALTER TABLE build_run_substitutions RENAME TO build_job_substitutions;

ALTER TABLE build_job_substitutions RENAME COLUMN run_id TO job_id;
ALTER TABLE build_segments RENAME COLUMN run_id TO job_id;

-- Postgres renames the table but leaves every constraint and index carrying the old name, and a
-- constraint whose name describes a table that no longer exists is a thing somebody has to decode
-- at exactly the wrong moment — reading a violation in a log at two in the morning.
ALTER TABLE build_jobs RENAME CONSTRAINT build_runs_state_check TO build_jobs_state_check;
ALTER TABLE build_jobs RENAME CONSTRAINT build_runs_finished_when_done TO build_jobs_finished_when_done;
ALTER TABLE build_job_substitutions
    RENAME CONSTRAINT build_run_substitutions_one_per_block TO build_job_substitutions_one_per_block;

ALTER INDEX uq_build_runs_active RENAME TO uq_build_jobs_active;
ALTER INDEX idx_build_runs_build RENAME TO idx_build_jobs_build;
ALTER INDEX idx_build_runs_schematic RENAME TO idx_build_jobs_schematic;
ALTER INDEX idx_build_run_substitutions_run RENAME TO idx_build_job_substitutions_job;

-- The trail follows the vocabulary, for the same reason and under the same exception as V16: these
-- rows can only have been written by the developer testing an unreleased feature, and they describe
-- the same acts the new constants name.

-- Constraint off first: every value below is one the old list does not allow.
ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_entries_action_check;

UPDATE audit_entries SET action = 'BUILD_JOB_START' WHERE action = 'BUILD_RUN_START';
UPDATE audit_entries SET action = 'BUILD_JOB_PAUSE' WHERE action = 'BUILD_RUN_PAUSE';
UPDATE audit_entries SET action = 'BUILD_JOB_RESUME' WHERE action = 'BUILD_RUN_RESUME';
UPDATE audit_entries SET action = 'BUILD_JOB_DELETE' WHERE action = 'BUILD_RUN_DELETE';

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
        'BUILD_JOB_START', 'BUILD_JOB_PAUSE', 'BUILD_JOB_RESUME', 'BUILD_JOB_DELETE'
    ));

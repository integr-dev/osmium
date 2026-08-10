-- Three pieces of dead schema that ddl-auto=update created and could never remove. It adds tables,
-- columns and indexes; it does not drop, rename or alter anything, so every one of these has been
-- sitting in the database since whatever change orphaned it.
--
-- IF EXISTS throughout, because this runs against two different starting points: a database
-- adopted by baseline-on-migrate, which has all three, and a fresh one built by V1, which has none.
-- Both end up in the same place.

-- Left behind by the agent -> host rename. `host_version` is the live column.
ALTER TABLE hosts DROP COLUMN IF EXISTS agent_version;

-- Left behind when a user's roles became a single role: User.role is a plain foreign key on
-- users.role_id, and nothing has mapped this join table since.
DROP TABLE IF EXISTS user_roles;

-- Superseded by idx_audit_entries_at_id when the audit trail moved to keyset paging. A composite
-- index on (at, id) already serves every query that an index on (at) alone would.
DROP INDEX IF EXISTS idx_audit_entries_at;

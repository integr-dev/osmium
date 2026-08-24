-- A paused job still holds its place on its server.
--
-- `uq_build_jobs_active` covered only ACTIVE, which left a hole the service could walk into: pause a
-- job, start a second one on the same build and the same server with different agents, then resume
-- the first — and two sets of agents are building the same blocks in the same place, each correct
-- from where it stood.
--
-- Paused is not finished. It keeps its segments, its assignees and its counts precisely so it can be
-- resumed, so it keeps its claim on the server too. DONE is the state that lets go.
--
-- The name loses `active` with the meaning: what the index enforces is one *unfinished* job per
-- build per server.
DROP INDEX uq_build_jobs_active;

CREATE UNIQUE INDEX uq_build_jobs_unfinished
    ON build_jobs (build_id, server_address) WHERE state IN ('ACTIVE', 'PAUSED');

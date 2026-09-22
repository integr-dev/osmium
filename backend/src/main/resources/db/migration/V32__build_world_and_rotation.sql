-- Where a plan is meant for, and which way round it goes.
--
-- A plan was a schematic and a coordinate, and a coordinate is not a place until it says which
-- world it is in: the same numbers are a different spot on every server and in every dimension.
-- Both are optional, as the placement is - a plan can be written before anybody knows where it is
-- going - and a job still takes its server from the agents it is started with. What a plan's server
-- adds is a check: only agents on it may be given the job.
--
-- Widths match the agent and map columns these are compared against.
ALTER TABLE builds ADD COLUMN server_address VARCHAR(255);
ALTER TABLE builds ADD COLUMN dimension VARCHAR(128);

-- Quarter turns clockwise, seen from above. The build turns inside its own box, so the placement
-- still names the minimum corner of whatever the turn produces.
ALTER TABLE builds ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE builds ADD CONSTRAINT builds_rotation_quarter CHECK (rotation IN (0, 90, 180, 270));

-- A job pins what it was started with, as it already pins the placement: a segment fetched an hour
-- in has to describe the blocks it described when it was handed out, whatever the plan says now.
ALTER TABLE build_jobs ADD COLUMN dimension VARCHAR(128);
ALTER TABLE build_jobs ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_rotation_quarter CHECK (rotation IN (0, 90, 180, 270));

-- A region can be written down before anybody has stood in the world and read a coordinate off it.
--
-- V34 made the corners, the server and the world all required, on the reasoning that six numbers
-- are not a place until they say which world they were read in. That is still true — and it is a
-- rule about *starting* the work, not about writing it down. A build plan has always been allowed
-- to exist unplaced and serverless, because deciding to dig somewhere comes before knowing exactly
-- where, and a plan that refuses to be saved until every field is settled is a plan nobody starts.
--
-- So the dispatch check moves to dispatch: `BuildJobService.startRegion` refuses a region with no
-- box or no server, and refuses a crew that is somewhere else. What the table holds is whatever an
-- operator has decided so far.
ALTER TABLE region_plans ALTER COLUMN server_address DROP NOT NULL;
ALTER TABLE region_plans ALTER COLUMN dimension DROP NOT NULL;

ALTER TABLE region_plans ALTER COLUMN min_x DROP NOT NULL;
ALTER TABLE region_plans ALTER COLUMN min_y DROP NOT NULL;
ALTER TABLE region_plans ALTER COLUMN min_z DROP NOT NULL;
ALTER TABLE region_plans ALTER COLUMN max_x DROP NOT NULL;
ALTER TABLE region_plans ALTER COLUMN max_y DROP NOT NULL;
ALTER TABLE region_plans ALTER COLUMN max_z DROP NOT NULL;

-- All six or none. Two corners of a box and four blanks describes nothing, and is the state a
-- half-filled form would otherwise save.
ALTER TABLE region_plans ADD CONSTRAINT region_plans_box_whole CHECK (
    (min_x IS NULL AND min_y IS NULL AND min_z IS NULL
        AND max_x IS NULL AND max_y IS NULL AND max_z IS NULL)
        OR (min_x IS NOT NULL AND min_y IS NOT NULL AND min_z IS NOT NULL
        AND max_x IS NOT NULL AND max_y IS NOT NULL AND max_z IS NOT NULL)
);

-- Still not empty when it is there at all: half-open, so equal corners are no blocks.
ALTER TABLE region_plans DROP CONSTRAINT region_plans_positive;

ALTER TABLE region_plans ADD CONSTRAINT region_plans_positive CHECK (
    min_x IS NULL OR (max_x > min_x AND max_y > min_y AND max_z > min_z)
);

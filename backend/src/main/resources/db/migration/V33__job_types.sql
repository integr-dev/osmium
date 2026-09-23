-- Jobs that are not builds: clearing a region, and charting one.
--
-- **One table, not three.** A job is already the record of "this crew, on this server, working
-- through these pieces, this far along" - and none of that is about schematics. What changes
-- between digging a hole, mapping a valley and raising a tower is where the pieces come from and
-- what an agent does when it gets one; everything the pool, the scheduler, the progress reports and
-- the interface do with them is the same act. Three tables would have been the same columns three
-- times, and three of every query that asks what the fleet is doing.
ALTER TABLE build_jobs ADD COLUMN type VARCHAR(16) NOT NULL DEFAULT 'BUILD';
ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_type_check CHECK (type IN ('BUILD', 'EXCAVATE', 'MAP'));

-- What to call it, pinned like everything else on a job.
--
-- A job used to be named by reaching through to its plan, which a job without one cannot do. It is
-- also the better answer for a build: renaming a plan halfway through a job used to rename the job,
-- the audit trail it had already written and the activity lines on every agent working it.
ALTER TABLE build_jobs ADD COLUMN name VARCHAR(128);
UPDATE build_jobs SET name = (SELECT b.name FROM builds b WHERE b.id = build_jobs.build_id);
ALTER TABLE build_jobs ALTER COLUMN name SET NOT NULL;

-- A region job has no plan and no file behind it, only two corners an operator read off the world.
ALTER TABLE build_jobs ALTER COLUMN build_id DROP NOT NULL;
ALTER TABLE build_jobs ALTER COLUMN schematic_id DROP NOT NULL;

-- The far corner, exclusive, matching the segments. The near one is `place_*`, which already means
-- "where the minimum corner is" and means exactly that here too.
--
-- A mapping job is a slab one block thick at the height the agents fly, so its `region_max_y` is
-- `place_y + 1`. That keeps one shape for every job rather than a special case that every reader of
-- a box would have to know about.
ALTER TABLE build_jobs ADD COLUMN region_max_x INTEGER;
ALTER TABLE build_jobs ADD COLUMN region_max_y INTEGER;
ALTER TABLE build_jobs ADD COLUMN region_max_z INTEGER;

-- All three or none, and present exactly when there is no plan to take a box from.
ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_region_whole CHECK (
    (region_max_x IS NULL AND region_max_y IS NULL AND region_max_z IS NULL)
        OR (region_max_x IS NOT NULL AND region_max_y IS NOT NULL AND region_max_z IS NOT NULL)
);

ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_region_by_type CHECK (
    (type = 'BUILD' AND build_id IS NOT NULL AND schematic_id IS NOT NULL AND region_max_x IS NULL)
        OR (type <> 'BUILD' AND build_id IS NULL AND schematic_id IS NULL AND region_max_x IS NOT NULL)
);

-- A region is not empty, whichever way round the operator gave the corners.
ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_region_positive CHECK (
    region_max_x IS NULL OR (region_max_x > place_x AND region_max_y > place_y AND region_max_z > place_z)
);

-- A survey that climbs over what is in the way, instead of holding one height the whole way across.
--
-- A flat flight is only flat where the ground is. Charting a valley at the height of its rim wastes
-- the flight, and charting it at the height of its floor flies agents into the hillside — so a
-- survey can now say that the height it was given is the *lowest* one, and that the agents rise
-- above anything they would otherwise hit and settle back down to it afterwards.
--
-- The height itself is unchanged and still required: a climb has to start somewhere, and the box is
-- still the one-block slab every reader of a region already understands. What this adds is what to
-- do about what sticks up through it.
--
-- False, everywhere it already exists: a survey planned before this held one height, and that is
-- what it was flown at.
ALTER TABLE region_plans ADD COLUMN rising BOOLEAN NOT NULL DEFAULT FALSE;

-- Pinned onto the job as the box is, and for the same reason: a plan edited mid-job is the next
-- job's plan, and how the agents now in the air are flying is not something an edit may change.
ALTER TABLE build_jobs ADD COLUMN rising BOOLEAN NOT NULL DEFAULT FALSE;

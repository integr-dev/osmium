-- Which world a tile belongs to.
--
-- Without this the three dimensions share one map. They are separate worlds at the same
-- coordinates, and the Nether's is compressed eightfold against the Overworld's on top of that, so
-- an agent walking through a portal did not add to the map - it overwrote it, chunk for chunk, with
-- terrain from somewhere else.
--
-- Part of the key rather than a column beside it: `0,0` in the Nether and `0,0` in the Overworld
-- are two rows, and the last agent to stand in either must not evict the other.
ALTER TABLE map_tiles ADD COLUMN dimension VARCHAR(64);

-- What every row already stored was: tiles were only ever written by agents, and an agent that had
-- not said which world it was in was assumed to be in the ordinary one. Backfilled rather than
-- dropped, because this is real terrain somebody walked.
UPDATE map_tiles SET dimension = 'overworld' WHERE dimension IS NULL;

ALTER TABLE map_tiles ALTER COLUMN dimension SET NOT NULL;

ALTER TABLE map_tiles DROP CONSTRAINT map_tiles_pkey;
ALTER TABLE map_tiles ADD PRIMARY KEY (server_address, dimension, chunk_x, chunk_z);

-- Every read is a rectangle of one world. The key leads with the server and the dimension, so this
-- covers the z half of the box the way the old index did.
DROP INDEX IF EXISTS idx_map_tiles_area;
CREATE INDEX idx_map_tiles_area ON map_tiles (server_address, dimension, chunk_z, chunk_x);

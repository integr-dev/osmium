-- What a pass over a schematic leaves behind, so nothing ever has to read the file twice.
--
-- The blocks themselves are not here and never will be: a billion rows is not a table. These two
-- are the summary everything downstream reads instead, and both come out of the one pass that was
-- already happening.

-- Where the schematic's minimum corner sits in its own coordinate space. Needed for two things: the
-- box the operator places and rotates, and the corner every cell coordinate below is measured from.
ALTER TABLE schematics ADD COLUMN origin_x INTEGER;
ALTER TABLE schematics ADD COLUMN origin_y INTEGER;
ALTER TABLE schematics ADD COLUMN origin_z INTEGER;

-- The edge of one cell of the grid below, in blocks. Stored rather than recomputed because it is
-- derived from the volume, and a later change to that rule must not silently reinterpret rows
-- written under the old one.
ALTER TABLE schematics ADD COLUMN cell_size INTEGER;

-- How many blocks sit in each cell of a coarse grid over the build.
--
-- This is what makes splitting work. Dividing a build between agents has to divide the *blocks*
-- evenly rather than the bounding box — a cathedral is mostly air and its spire is solid, so four
-- equal boxes can hand one agent most of the work. Counting per cell turns that into arithmetic
-- over a few hundred thousand numbers instead of a second pass over a billion.
--
-- Only non-empty cells are stored. A sparse build has a bounding box orders of magnitude larger
-- than the thing inside it, and its empty cells would be a table larger than the schematic.
CREATE TABLE schematic_cells
(
    schematic_id BIGINT  NOT NULL REFERENCES schematics (id) ON DELETE CASCADE,
    -- Cell coordinates, measured from the schematic's own minimum corner, so never negative.
    cx           INTEGER NOT NULL,
    cy           INTEGER NOT NULL,
    cz           INTEGER NOT NULL,
    blocks       INTEGER NOT NULL,

    PRIMARY KEY (schematic_id, cx, cy, cz),
    CONSTRAINT schematic_cells_blocks_check CHECK (blocks > 0)
);

-- Every read of this is "all cells for one schematic", to sum or to split.
CREATE INDEX idx_schematic_cells_schematic ON schematic_cells (schematic_id);

-- What has to be gathered before the build can start, by block rather than by block state: stairs
-- facing east and stairs facing west are the same thing to collect, and a list split by state is a
-- list nobody can shop from.
CREATE TABLE schematic_materials
(
    schematic_id BIGINT       NOT NULL REFERENCES schematics (id) ON DELETE CASCADE,
    block_name   VARCHAR(128) NOT NULL,
    blocks       BIGINT       NOT NULL,

    PRIMARY KEY (schematic_id, block_name),
    CONSTRAINT schematic_materials_blocks_check CHECK (blocks > 0)
);

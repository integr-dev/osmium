-- The world as agents have seen it from above, one row per chunk.
--
-- One pixel per block column, vanilla's zoom zero, so a row is exactly a 16x16 tile and the map
-- lines up with the coordinates an operator reads off F3.
--
-- Keyed by the server rather than by the agent, because a map is about a place. Every agent on an
-- address contributes to the same map, and the last one to walk over a chunk is the one whose
-- reading stands - the world is shared, and the newest look at it is the truest.
CREATE TABLE map_tiles
(
    server_address VARCHAR(255) NOT NULL,
    -- Chunk coordinates, not block ones. Signed: worlds run in both directions from the origin.
    chunk_x        INTEGER      NOT NULL,
    chunk_z        INTEGER      NOT NULL,

    -- The distinct block names on this tile's surface, comma-separated, indexed by `blocks`.
    --
    -- Names and not colours. What colour a block reads as is a question about textures, which live
    -- in the frontend beside the atlas the 3D view is drawn from; storing names keeps the two views
    -- agreeing and lets the whole map be re-coloured without re-walking the world.
    --
    -- At most 256 entries, because 256 columns can hold at most 256 different blocks.
    palette        TEXT         NOT NULL,
    -- 256 bytes, row-major from the north-west corner, each an index into `palette`.
    blocks         BYTEA        NOT NULL,
    -- 256 signed 16-bit little-endian heights, matching `blocks` cell for cell. -32768 means the
    -- column held nothing to draw. Kept because vanilla shades a map by the step up or down to the
    -- column north of it, and that relief is most of what makes terrain readable.
    heights        BYTEA        NOT NULL,

    -- Who last looked, for the operator who wants to know where a reading came from. Plain columns
    -- and not a relation, like chat and audit: deleting an agent must not erase the ground it
    -- charted.
    agent_id       BIGINT,
    agent_label    VARCHAR(64)  NOT NULL,
    at             TIMESTAMPTZ  NOT NULL,

    PRIMARY KEY (server_address, chunk_x, chunk_z)
);

-- Every read is a rectangle: the part of one server's map a screen is currently showing. The
-- primary key already leads with the server and then x, so this covers the z half of the box.
CREATE INDEX idx_map_tiles_area ON map_tiles (server_address, chunk_z, chunk_x);

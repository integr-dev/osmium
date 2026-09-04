-- Where the fleet last saw somebody, one row per person per world.
--
-- The map already stores the ground an agent walked over; this is the other half of the same
-- record - who was standing on it. It exists for the question an operator asks about somebody who
-- is no longer in view: where were they when we last knew.
--
-- Keyed by the server and the world for the reason the tiles are: a position is about a place, and
-- `0,0` in the Nether is not `0,0` in the Overworld. Every agent on an address contributes to the
-- same record, and the newest sighting is the one that stands.
--
-- One row per subject, replaced rather than appended to. This is not a history of where somebody
-- has been - that is what a trail is, and it lives in the browser for as long as a screen is open.
-- What is kept here is the last thing anybody knew, which is exactly one fact per person.
CREATE TABLE last_seen_positions
(
    server_address VARCHAR(255)     NOT NULL,
    dimension      VARCHAR(64)      NOT NULL,

    -- 'AGENT' or 'PLAYER'. Ours are keyed by id, because two agents may share a Minecraft name and
    -- an agent is named by its Osmium label rather than by the account it happens to be wearing.
    kind           VARCHAR(16)      NOT NULL,
    -- The agent's id written out, or the player's name.
    subject        VARCHAR(64)      NOT NULL,

    -- What to call them on screen, and what to fetch their head by. Plain columns and not relations,
    -- like the map's `agent_label`: deleting an agent must not erase where it was last seen.
    label          VARCHAR(64)      NOT NULL,
    face           VARCHAR(64),

    -- Block coordinates, as the position was reported. `y` is not drawn on the map and is kept
    -- anyway: a position with two of its three numbers is a position that cannot be gone back to.
    x              DOUBLE PRECISION NOT NULL,
    y              DOUBLE PRECISION NOT NULL,
    z              DOUBLE PRECISION NOT NULL,

    at             TIMESTAMPTZ      NOT NULL,

    PRIMARY KEY (server_address, dimension, kind, subject)
);

-- What the storage screen measures an age against, and what a purge deletes by. Every other read is
-- one world's worth of rows, which the primary key already leads with.
CREATE INDEX idx_last_seen_at ON last_seen_positions (at);

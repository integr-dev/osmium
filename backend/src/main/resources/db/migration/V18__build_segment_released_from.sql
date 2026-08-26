-- Release used to mean nothing.
--
-- Taking a segment off an agent put it back to PENDING and then asked the scheduler to fill the
-- gap, which handed it straight back to the same agent — it was the only idle one, and the piece
-- was the only free one. The operator pressed a button and watched the row redraw itself exactly
-- as it had been.
--
-- So a released segment remembers who it was taken from, and the scheduler will not pair the two
-- again. Anyone else may have it; that agent may only be given it deliberately, by an operator
-- assigning it, which is what clears this.
--
-- Nulled rather than blocking the delete, like `agent_id` above it: the marker is about a decision,
-- and a decision about an agent that no longer exists is not worth keeping a row alive for.
ALTER TABLE build_segments
    ADD COLUMN released_from_agent_id bigint REFERENCES agents (id) ON DELETE SET NULL;

COMMENT ON COLUMN build_segments.released_from_agent_id IS
    'Agent an operator took this segment from. The scheduler will not give it back to them.';

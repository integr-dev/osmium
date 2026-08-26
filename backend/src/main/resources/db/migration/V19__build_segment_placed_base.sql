-- What was already standing when the current holder was given this piece.
--
-- A host reports what *it* has placed, counting from zero: it is told to build a box and starts
-- counting when it starts placing. That is the only number a host can produce without remembering
-- anything across a reconnect — and it meant every hand-over and every resume dropped the segment
-- back to nothing, because the backend wrote down the last thing it was told.
--
-- So the count is now made of two parts: what was there when this holder took over, and what this
-- holder says it has done since. Set on every dispatch, added to on every report.
--
-- Deltas would have been the other way to do it, and are worse: a report that arrives twice counts
-- twice, one that never arrives is lost for good, and a host that restarts mid-piece re-places
-- blocks it already placed and reports them again. An absolute-per-assignment is idempotent —
-- the same report applied twice leaves the same number — which is what makes it safe over a
-- socket that reconnects.
ALTER TABLE build_segments
    ADD COLUMN blocks_placed_base bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN build_segments.blocks_placed_base IS
    'Blocks standing when the current holder took the piece. Reports are counted on top of it.';

-- Everything already recorded was reported against an assignment that is still in place, so the
-- base for those is zero — which is what the default gives them.

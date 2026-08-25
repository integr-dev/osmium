-- How a host proves it may fetch one segment's blocks.
--
-- The blocks cannot go down the socket: `HostConnections.send` is blocking and serialised per host,
-- so a payload of any size there stalls heartbeats, vitals, chat and every command for every agent
-- on that machine — and vitals go stale after thirty seconds. That is the control plane. The blocks
-- are bulk, and bulk belongs on its own request.
--
-- Which leaves the question of what authenticates that request, and the answer is deliberately not
-- the host's enrolment token: that is the credential for the whole machine and its every agent, and
-- putting it on an HTTP surface widens what a leaked log line is worth. A ticket is a capability for
-- exactly one segment, minted when the segment is handed out and carried in a header.
--
-- **Its life is the assignment, not a clock.** Releasing the segment, finishing it, or handing it to
-- somebody else clears the column, so the ticket dies with the reason it existed rather than
-- outliving it until a timer notices. Reassignment mints a new one.
ALTER TABLE build_segments ADD COLUMN fetch_ticket VARCHAR(64);

-- Looked up by the ticket alone: the request carries it, and the segment it names is whatever the
-- ticket was minted for. Unique so a lookup by it cannot be ambiguous, and partial because most
-- segments over a fleet's lifetime hold none.
CREATE UNIQUE INDEX uq_build_segments_ticket
    ON build_segments (fetch_ticket) WHERE fetch_ticket IS NOT NULL;

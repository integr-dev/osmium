-- A state for the gap between `connect` being accepted and the host saying what came of it.
--
-- The command is accepted in milliseconds; the host takes seconds to join a Minecraft server. With
-- nothing between LINKED and ONLINE, an operator who pressed Connect saw the badge still reading
-- LINKED - the same thing it read before the press - so a working button and a broken one were
-- indistinguishable until the outcome happened to arrive.
--
-- SETUP_PENDING already solved this for the other long-running command. This is that, for connect.
ALTER TABLE agents
    DROP CONSTRAINT agents_state_check;

ALTER TABLE agents
    ADD CONSTRAINT agents_state_check CHECK (state IN (
        'UNLINKED', 'SETUP_PENDING', 'LINKED', 'CONNECTING', 'ONLINE',
        'NEEDS_RELINK', 'CONNECT_FAILED', 'STALE'
    ));

-- When the command went out, so the claim can expire.
--
-- A pending state that cannot end is worse than the LINKED it replaced: before it existed, a connect
-- nobody answered left the agent where the operator could simply press the button again, whereas a
-- CONNECTING that never clears refuses the retry *and* goes on claiming something is happening.
--
-- A column rather than a timer in memory, because a restart must not strand an agent here. Nullable
-- because it is only meaningful in one state, and null in every other.
ALTER TABLE agents
    ADD COLUMN connecting_since timestamp(6) with time zone;

-- Automatic reconnection, owned by the backend.
--
-- A kicked agent used to sit at LINKED until somebody pressed Connect. For a fleet meant to be
-- building that is an outage needing a human, and the human is not necessarily awake.
--
-- **Not the host's job**, though the host is where the disconnect is noticed. The rule the whole
-- design rests on is that a host never changes its own mind about where an agent is: it reports,
-- the backend decides. A host that reconnected itself would be asserting a state nobody asked for,
-- and the backend would have no way to tell that from an operator's own connect - which is exactly
-- the ambiguity `wanted` exists to remove.
--
-- `wanted` is a wish, not a state. `state` says where the agent is; this says where somebody wants
-- it to be, and the gap between them is what the sweep acts on. Set by `connect`, cleared by
-- `disconnect`, and untouched by anything a host reports - a state arriving from a host says where
-- the agent got to, and has no opinion about where it belongs.
--
-- The other two make the backoff survive a restart. Without them a backend that came back up would
-- put every agent on its first retry at once, and hammer whatever server had just gone down.
--
-- The defaults are not decoration: a `not null` column with no default cannot be added to a table
-- that already has rows. See the comment on `agents.chat_listener`.
--
-- Whether any of this happens at all is per agent, and lives in `agents.settings` under
-- `connect.rejoin` - so an agent nobody has configured behaves exactly as it did before this
-- migration, `wanted` and all.

ALTER TABLE agents
    ADD COLUMN wanted boolean NOT NULL DEFAULT false,
    ADD COLUMN rejoin_at timestamp with time zone,
    ADD COLUMN rejoin_attempts integer NOT NULL DEFAULT 0;

-- An agent that is in game right now was put there by an operator, and is therefore wanted. Without
-- this the first drop after an upgrade would not be rejoined, because nobody had pressed Connect
-- since the column existed - and the setting would look broken to whoever had just turned it on.
UPDATE agents
SET wanted = true
WHERE state IN ('ONLINE', 'CONNECTING');

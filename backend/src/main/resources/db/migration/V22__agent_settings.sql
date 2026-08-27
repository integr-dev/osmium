-- Per-agent configuration, as a flat map the backend does not interpret.
--
-- The settings themselves are declared by the interface: it knows what a chat-format pattern is and
-- what a sensible one looks like, and it is where an operator sets one. This backend stores what
-- they chose and relays it to the host, exactly as it relays a login `method` without knowing what
-- any of them mean.
--
-- Held as JSON text rather than a column per setting. A column per setting would need a migration,
-- a DTO field and a release for every new one, to store something nothing here reads - and the host
-- ignores keys it does not know, so the two ends can move independently.
--
-- Nullable, meaning "nothing set", which is not the same as an empty map: an agent nobody has
-- configured has never been sent anything, and one configured back to empty has.

ALTER TABLE agents
    ADD COLUMN settings varchar(4096);

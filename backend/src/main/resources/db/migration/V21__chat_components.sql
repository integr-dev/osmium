-- Chat, as the server actually styled it.
--
-- Until now a line was stored as the plain string a host flattened it to, which threw away
-- everything a Minecraft server uses to make chat legible: rank prefixes, the colour that separates
-- a whisper from the room, the styling on a player's name. What the server sends is a tree, and this
-- keeps it.
--
-- Nullable, and it stays nullable. A host that sends none - anything the agent said itself, a server
-- sending plain text, a host older than this column - is ordinary, and `body` is still the whole
-- line in plain form. Nothing reads this without falling back to that.
--
-- Held as text and never parsed by the backend, which has no opinion about what a chat component is:
-- the host resolves the server's translation keys and drops everything interactive before sending
-- it, and the interface draws the result. That is the same rule the host envelope's payload follows.

ALTER TABLE chat_messages
    ADD COLUMN components varchar(8192);

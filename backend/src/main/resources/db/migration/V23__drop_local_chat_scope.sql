-- Drops `LOCAL` from the chat scopes.
--
-- It was declared for proximity chat, and nothing ever produced it. Scope is classified by the host
-- from the raw packet type, and there is no packet that says "this was proximity chat" - a server
-- with it writes an ordinary chat line and puts the distinction in the text, which is precisely the
-- inference the host is forbidden from making. So the value could only ever have been set by a
-- backend guessing from message content, and the backend does not read message content.
--
-- A scope nothing can produce is worse than a missing one. It sat in the enum, in the per-agent
-- filter and in three documentation tables, describing a feed that was always empty, and every
-- reader of that code had to work out for themselves that it never fired. A server with proximity
-- chat is served by `global` plus a chat pattern, like every other formatting decision a server makes.
--
-- The UPDATE is defensive rather than expected: no host this repository has ever shipped emits
-- `local`, so there should be nothing to move. It is here because a CHECK that fails mid-migration
-- takes the whole application down at boot, and GLOBAL is where such a line would have belonged.

UPDATE chat_messages
SET scope = 'GLOBAL'
WHERE scope = 'LOCAL';

ALTER TABLE chat_messages
    DROP CONSTRAINT chat_messages_scope_check;

ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_scope_check CHECK (scope IN ('OUTBOUND', 'DIRECT', 'GLOBAL'));

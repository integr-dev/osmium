-- An agent no longer has to be pointed at a Minecraft server.
--
-- Requiring one at creation imposed an order with nothing behind it: an operator had to decide where
-- an agent would play before it had been set up, and therefore before they knew the credential even
-- worked. The natural order is create, set up, assign, connect.
--
-- It also lets the system say something true that it could not before — *this agent is ready and
-- assigned nowhere*. That state was previously faked by pointing an agent at a server it was not
-- connected to, which then appeared under Active servers with nobody on it.
ALTER TABLE agents
    ALTER COLUMN server_address DROP NOT NULL;

-- Rows created before this could not hold a blank, since the API rejected one — but the entity
-- default was the empty string, so anything written around the API could have. Null is now the one
-- way to say "nowhere", and two spellings of it would be one too many.
UPDATE agents SET server_address = NULL WHERE server_address = '';

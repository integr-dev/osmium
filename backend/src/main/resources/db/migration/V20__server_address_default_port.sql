-- The default port is no longer written onto a server address.
--
-- It used to be appended to anything that had none, so that `mc.example.com` and
-- `mc.example.com:25565` could not become two servers under a grouping key compared as a string.
-- That worked, and cost something nobody expected: a host cannot tell an operator who typed a bare
-- hostname from one who deliberately chose port 25565, and the first of those is exactly the case
-- where the SRV record decides. Agents dialled 25565 on servers whose record points elsewhere.
--
-- Normalisation now strips the redundant port instead of adding it, so the two spellings still
-- collapse to one - the one that was typed. These rows were written under the old rule and are
-- brought to the new one, because the key is compared exactly and a mix would split each affected
-- server in half: half its agents, its jobs and its chat under one spelling and half under the
-- other.
--
-- Only the default port. An address naming any other port is a deliberate socket and stays as it is.

UPDATE agents
SET server_address = left(server_address, length(server_address) - 6)
WHERE server_address LIKE '%:25565'
  AND length(server_address) > 6;

UPDATE build_jobs
SET server_address = left(server_address, length(server_address) - 6)
WHERE server_address LIKE '%:25565'
  AND length(server_address) > 6;

-- Chat is filed under the address the agent had when the line arrived, so history would otherwise
-- stop being found the moment its agent moved to the new spelling.
UPDATE chat_messages
SET server_address = left(server_address, length(server_address) - 6)
WHERE server_address LIKE '%:25565'
  AND length(server_address) > 6;

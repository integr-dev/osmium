package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentInventoryResponse
import org.springframework.stereotype.Component
import java.util.concurrent.ConcurrentHashMap

/**
 * The latest inventory each agent reported. **In memory, latest wins, never written to Postgres.**
 *
 * Out of the database for the reason [AgentTelemetryStore] is: it has no historical value, it is
 * rewritten every time an agent picks something up, and a restart must not be able to resurrect the
 * contents of a chest an agent emptied an hour ago and present it as what it is holding now.
 *
 * **It does not age out, and that is the difference from the telemetry.** Vitals are resent every
 * few seconds whether or not they changed, so a stale sample there means a host that has stopped
 * talking, and a time limit reads it correctly. An inventory is sent only when items *move*, so
 * nothing refreshes the one an agent is standing still with — and a time limit reads a quiet agent
 * as an agent nobody has heard from. That is exactly what it did: an operator reloading the page a
 * minute after opening it was told the agent had reported nothing, until it next picked something
 * up.
 *
 * What actually invalidates an inventory is the session ending, which the backend is told about, so
 * that is what clears it — see [forget] and its callers. A host that reconnects restates what its
 * agents are carrying, which covers the other direction: a backend that restarted holding none of
 * this does not have to wait for an item to move either.
 */
@Component
class AgentInventoryStore {

    private val carried = ConcurrentHashMap<Long, AgentInventoryResponse>()

    fun record(agentId: Long, inventory: AgentInventoryResponse) {
        carried[agentId] = inventory
    }

    /** What the agent is carrying, or null when it has reported nothing this session. */
    fun find(agentId: Long?): AgentInventoryResponse? = carried[agentId ?: return null]

    /**
     * Forgets what an agent was carrying.
     *
     * Called when it leaves the game and when it is deleted. Leaving is the point: what it had is
     * no longer what it *has*, and holding on would show the last session's pockets against an
     * agent that is offline. It says what it is carrying again on its next spawn.
     */
    fun forget(agentId: Long) {
        carried.remove(agentId)
    }
}

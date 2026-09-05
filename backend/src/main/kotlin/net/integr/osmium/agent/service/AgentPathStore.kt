package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentPathResponse
import org.springframework.stereotype.Component
import java.util.concurrent.ConcurrentHashMap

/**
 * Where each agent is currently going. **In memory, latest wins, never written to Postgres.**
 *
 * The same bargain as [AgentTelemetryStore], for a stronger reason. Telemetry is kept out of the
 * database because it has no historical value; a path is kept out because an old one is actively
 * misleading - a position from an hour ago is still the only answer there is about where somebody
 * was, and a journey from an hour ago is a line drawn to a place nobody is going.
 *
 * **Only live journeys are held.** The three states that end one clear the entry instead of
 * replacing it, so a fresh page never draws a path that finished before it was opened. The ending
 * itself still goes out on the live stream, which is what lets a screen already showing the line
 * clear it and say what happened.
 */
@Component
class AgentPathStore {

    private val paths = ConcurrentHashMap<Long, AgentPathResponse>()

    /**
     * Takes one update, and answers with the whole journey as it now stands.
     *
     * **Merged, not replaced.** Most updates carry only how far along the agent has got: the nodes
     * are sent when the line is drawn and again on every re-plan, and a few hundred points a second
     * is bandwidth spent redrawing a line that has moved by one. So an update with no `nodes` keeps
     * the ones already held, and the same for the goal and the world it is in.
     *
     * The merged value is what a page load reads. What goes on the live stream is the update as it
     * arrived - a browser merges it the same way, and sending the merge would undo the saving.
     */
    fun record(update: AgentPathResponse): AgentPathResponse {
        if (!update.state.live) {
            paths.remove(update.agentId)
            return update
        }

        val held = paths[update.agentId]
        val merged = update.copy(
            dimension = update.dimension ?: held?.dimension,
            goal = update.goal ?: held?.goal,
            nodes = update.nodes ?: held?.nodes,
        )

        paths[update.agentId] = merged
        return merged
    }

    /** The journey this agent is on, or null when it is not on one. */
    fun find(agentId: Long?): AgentPathResponse? = paths[agentId ?: return null]

    /** Every journey in progress, for a screen that has just been opened. */
    fun all(): List<AgentPathResponse> = paths.values.toList()

    /**
     * Called when an agent is deleted, and when its session ends without the host saying so.
     *
     * A host that is killed rather than stopped never sends the `idle` that would clear this, so the
     * line would otherwise outlive the agent walking it.
     */
    fun forget(agentId: Long) {
        paths.remove(agentId)
    }
}

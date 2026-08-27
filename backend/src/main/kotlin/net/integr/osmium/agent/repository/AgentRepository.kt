package net.integr.osmium.agent.repository

import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import org.springframework.data.jpa.repository.JpaRepository

interface AgentRepository : JpaRepository<Agent, Long> {
    fun existsByLabel(label: String): Boolean
    fun countByHostId(hostId: Long): Long
    fun findAllByHostId(hostId: Long): List<Agent>

    /** For the sweep that expires a stalled CONNECTING, which has no reason to read the whole fleet. */
    fun findAllByState(state: AgentState): List<Agent>

    /**
     * For the rejoin sweep.
     *
     * Deliberately not narrowed to the states that need a reconnect: the sweep also clears the
     * backoff off an agent that made it back into the game, and that agent is ONLINE. Filtering to
     * the offline ones would leave a stale attempt count on everything that recovered, so the *next*
     * drop would start at whatever delay the last one had climbed to.
     */
    fun findAllByWantedIsTrue(): List<Agent>
}

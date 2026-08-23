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
}

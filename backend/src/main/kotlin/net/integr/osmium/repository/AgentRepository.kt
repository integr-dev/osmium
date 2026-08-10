package net.integr.osmium.repository

import net.integr.osmium.model.Agent
import org.springframework.data.jpa.repository.JpaRepository

interface AgentRepository : JpaRepository<Agent, Long> {
    fun existsByLabel(label: String): Boolean
    fun countByHostId(hostId: Long): Long
    fun findAllByHostId(hostId: Long): List<Agent>
}

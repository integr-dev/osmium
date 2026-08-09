package net.integr.osmium.repository

import net.integr.osmium.model.Bot
import org.springframework.data.jpa.repository.JpaRepository

interface BotRepository : JpaRepository<Bot, Long> {
    fun existsByLabel(label: String): Boolean
    fun countByHostId(hostId: Long): Long
    fun findAllByHostId(hostId: Long): List<Bot>
}

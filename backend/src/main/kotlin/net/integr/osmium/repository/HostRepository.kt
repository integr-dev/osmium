package net.integr.osmium.repository

import net.integr.osmium.model.Host
import org.springframework.data.jpa.repository.JpaRepository

interface HostRepository : JpaRepository<Host, Long> {
    fun existsByName(name: String): Boolean
}

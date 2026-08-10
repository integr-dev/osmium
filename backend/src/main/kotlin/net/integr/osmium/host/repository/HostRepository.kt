package net.integr.osmium.host.repository

import net.integr.osmium.host.model.Host
import org.springframework.data.jpa.repository.JpaRepository

interface HostRepository : JpaRepository<Host, Long> {
    fun existsByName(name: String): Boolean
}

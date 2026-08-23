package net.integr.osmium.build.repository

import net.integr.osmium.build.model.Build
import org.springframework.data.jpa.repository.JpaRepository

interface BuildRepository : JpaRepository<Build, Long> {
    /** Newest first, matching the schematic library: the thing just made is the thing wanted. */
    fun findAllByOrderByCreatedAtDesc(): List<Build>

    fun existsByName(name: String): Boolean

    /** For a rename, which must not collide with anything except the row being renamed. */
    fun existsByNameAndIdNot(name: String, id: Long): Boolean
}

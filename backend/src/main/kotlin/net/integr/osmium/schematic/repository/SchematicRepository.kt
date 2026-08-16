package net.integr.osmium.schematic.repository

import net.integr.osmium.schematic.model.Schematic
import net.integr.osmium.schematic.model.SchematicStatus
import org.springframework.data.jpa.repository.JpaRepository

interface SchematicRepository : JpaRepository<Schematic, Long> {

    fun findAllByOrderByCreatedAtDesc(): List<Schematic>

    fun findAllByStatusIn(statuses: Collection<SchematicStatus>): List<Schematic>

    fun existsByName(name: String): Boolean

    fun existsByNameAndIdNot(name: String, id: Long): Boolean
}

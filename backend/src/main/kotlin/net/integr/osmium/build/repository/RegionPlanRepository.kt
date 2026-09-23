package net.integr.osmium.build.repository

import net.integr.osmium.build.model.RegionPlan
import org.springframework.data.jpa.repository.JpaRepository

interface RegionPlanRepository : JpaRepository<RegionPlan, Long> {
    /** Newest first, matching the build plans beside them: the thing just made is the thing wanted. */
    fun findAllByOrderByCreatedAtDesc(): List<RegionPlan>

    fun existsByName(name: String): Boolean

    /** For a rename, which must not collide with anything except the row being renamed. */
    fun existsByNameAndIdNot(name: String, id: Long): Boolean
}

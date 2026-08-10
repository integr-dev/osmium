package net.integr.osmium.activity.repository

import net.integr.osmium.activity.model.ActivityEntry
import org.springframework.data.domain.Limit
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant

interface ActivityEntryRepository : JpaRepository<ActivityEntry, Long> {

    /** Every agent's incidents merged, newest first: what the dashboard shows. */
    @Query(
        """
        select e from ActivityEntry e
        where e.at < :beforeAt or (e.at = :beforeAt and e.id < :beforeId)
        order by e.at desc, e.id desc
        """,
    )
    fun page(
        @Param("beforeAt") beforeAt: Instant,
        @Param("beforeId") beforeId: Long,
        limit: Limit,
    ): List<ActivityEntry>

    @Query(
        """
        select e from ActivityEntry e
        where (e.at < :beforeAt or (e.at = :beforeAt and e.id < :beforeId))
          and e.agentId = :agentId
        order by e.at desc, e.id desc
        """,
    )
    fun pageForAgent(
        @Param("beforeAt") beforeAt: Instant,
        @Param("beforeId") beforeId: Long,
        @Param("agentId") agentId: Long,
        limit: Limit,
    ): List<ActivityEntry>

    @Modifying
    @Query("delete from ActivityEntry e where e.at < :cutoff")
    fun deleteOlderThan(@Param("cutoff") cutoff: Instant): Int
}

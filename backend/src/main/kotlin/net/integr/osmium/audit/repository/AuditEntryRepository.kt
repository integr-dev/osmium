package net.integr.osmium.audit.repository

import net.integr.osmium.audit.model.AuditEntry
import org.springframework.data.domain.Limit
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant

interface AuditEntryRepository : JpaRepository<AuditEntry, Long> {

    fun findAllByOrderByAtDescIdDesc(limit: Limit): List<AuditEntry>

    /**
     * Bulk delete rather than loading and removing entities: a purge can touch far more rows than
     * belong in a persistence context, and nothing here needs entity lifecycle callbacks.
     */
    @Modifying
    @Query("delete from AuditEntry e where e.at < :cutoff")
    fun deleteOlderThan(@Param("cutoff") cutoff: Instant): Int
}

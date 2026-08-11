package net.integr.osmium.audit.repository

import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.model.AuditEntry
import org.springframework.data.domain.Limit
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant

interface AuditEntryRepository : JpaRepository<AuditEntry, Long> {

    /**
     * One page of the trail, newest first, starting strictly before `(beforeAt, beforeId)`.
     *
     * The position is a keyset rather than an offset - see [net.integr.osmium.audit.service.AuditCursor]
     * for why - and `(at desc, id desc)` matches `idx_audit_entries_at_id`, so paging deep into the
     * trail costs the same as the first page.
     *
     * `id` breaks ties on `at`. Two entries recorded in the same instant are possible under
     * concurrent commands, and without the tiebreak one of them would be skipped at a page boundary.
     *
     * Matching an [AuditAction] by name is done by the caller and passed in, because the column
     * holds the enum constant and a caller searching for "chat" means the label, not the string.
     */
    @Query(
        """
        select e from AuditEntry e
        where (e.at < :beforeAt or (e.at = :beforeAt and e.id < :beforeId))
          and (lower(e.account) like :needle escape '\'
               or lower(e.target) like :needle escape '\'
               or lower(e.detail) like :needle escape '\'
               or e.action in :actions)
        order by e.at desc, e.id desc
        """,
    )
    fun page(
        @Param("beforeAt") beforeAt: Instant,
        @Param("beforeId") beforeId: Long,
        @Param("needle") needle: String,
        @Param("actions") actions: Collection<AuditAction>,
        limit: Limit,
    ): List<AuditEntry>

    /**
     * One batch of a closed range, newest first, continuing strictly before `(beforeAt, beforeId)`.
     *
     * Keyset again rather than an offset, for the same reason and against the same index: an export
     * walks the whole range in batches, and an offset would make each batch cost more than the last.
     * `from` is inclusive and `to` exclusive, so consecutive ranges neither overlap nor leave a gap.
     */
    @Query(
        """
        select e from AuditEntry e
        where e.at >= :from and e.at < :to
          and (e.at < :beforeAt or (e.at = :beforeAt and e.id < :beforeId))
        order by e.at desc, e.id desc
        """,
    )
    fun range(
        @Param("from") from: Instant,
        @Param("to") to: Instant,
        @Param("beforeAt") beforeAt: Instant,
        @Param("beforeId") beforeId: Long,
        limit: Limit,
    ): List<AuditEntry>

    @Query("select count(e) from AuditEntry e where e.at >= :from and e.at < :to")
    fun countInRange(@Param("from") from: Instant, @Param("to") to: Instant): Long

    /**
     * Bulk delete rather than loading and removing entities: a purge can touch far more rows than
     * belong in a persistence context, and nothing here needs entity lifecycle callbacks.
     */
    @Modifying
    @Query("delete from AuditEntry e where e.at < :cutoff")
    fun deleteOlderThan(@Param("cutoff") cutoff: Instant): Int
}

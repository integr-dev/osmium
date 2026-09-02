package net.integr.osmium.storage.service

import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.storage.dto.PurgeRequest
import net.integr.osmium.storage.dto.PurgeResponse
import net.integr.osmium.storage.dto.ReclaimResponse
import net.integr.osmium.storage.dto.StorageAreaResponse
import net.integr.osmium.storage.dto.StorageResponse
import net.integr.osmium.storage.model.StorageArea
import net.integr.osmium.storage.repository.StorageRepository
import net.integr.osmium.storage.repository.TableSize
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Duration
import java.time.Instant

/**
 * What the deployment is storing, and the two ways of making it smaller.
 *
 * **Deleting and reclaiming are separate, and the screen says so.** Deleting a month of chat leaves
 * the space exactly where it was, as dead rows the table will reuse; the disk does not shrink until
 * something rewrites the table. An operator who deletes and sees no change concludes the button is
 * broken, so the two are two actions with two results rather than one that quietly does both — the
 * second takes an exclusive lock, which is not something to do on somebody's behalf.
 *
 * Not annotated transactional at the class level, unlike most services here: `VACUUM` cannot run
 * inside a transaction at all, and a read-only default would put one around it.
 */
@Service
class StorageService(
    private val storage: StorageRepository,
    private val auditService: AuditService,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** What everything costs, by area, largest first. */
    fun breakdown(): StorageResponse {
        val sizes = storage.sizes().associateBy { it.table }

        val areas = StorageArea.entries.map { area ->
            val tables = if (area == StorageArea.OTHER) {
                sizes.keys.filterNot { it in StorageArea.CLAIMED }.sorted()
            } else {
                area.tables
            }
            val measured = tables.mapNotNull { sizes[it] }

            StorageAreaResponse(
                area = area,
                totalBytes = measured.sumOf { it.totalBytes },
                deadBytes = measured.sumOf { reclaimable(it) },
                rows = measured.sumOf { it.rows },
                // Only for the one table a purge would act on: the oldest row in an area's
                // supporting tables is not what a retention control is measured against.
                oldest = area.purges?.let { storage.oldest(it, checkNotNull(area.dated)) },
                purgeable = area.purgeable,
                tables = tables,
            )
        }

        return StorageResponse(
            databaseBytes = storage.databaseBytes(),
            areas = areas.sortedByDescending { it.totalBytes },
        )
    }

    /**
     * Roughly how much a table would give back if it were rewritten.
     *
     * An estimate twice over, and labelled as one everywhere it surfaces. Postgres does not track
     * dead *bytes*, only dead *tuples*, so the reading is the dead share of what the table costs.
     *
     * **Against the total, not the heap.** A rewrite rebuilds the indexes as well, and they bloat
     * alongside the rows they point at — an empty `schematic_cells` here is 66 MB of heap and 58 MB
     * of index, so measuring the heap alone reported half of what pressing the button would return
     * and made it look not worth pressing.
     *
     * The empty case is the one worth surfacing at all. A table can hold no rows and still occupy a
     * hundred megabytes: the space that emptied it was never handed back, and once the statistics
     * have caught up there are no dead tuples left to point at either. Nothing else on this screen
     * would explain where the disk went.
     */
    private fun reclaimable(size: TableSize): Long {
        val tuples = size.rows + size.deadRows
        if (tuples == 0L) return size.totalBytes
        return size.totalBytes * size.deadRows / tuples
    }

    /**
     * Deletes an area's rows, optionally keeping the recent ones.
     *
     * Refused for an area that has no single table to delete from — see
     * [StorageArea.purges]. Those are reachable through the screens that understand what hangs off
     * them, and a second deletion path that did not would take a schematic's cells without the
     * schematic, or a job's segments out from under a job.
     */
    @Transactional
    fun purge(area: StorageArea, request: PurgeRequest): PurgeResponse {
        val table = area.purges
        require(table != null) { "${area.name.lowercase()} cannot be purged here" }

        val before = request.keepDays?.let { Instant.now().minus(Duration.ofDays(it.toLong())) }
        val deleted = storage.purge(table, checkNotNull(area.dated), before)

        // Recorded whatever the count, zero included: that somebody pressed this is the fact worth
        // keeping, and a purge that removed nothing is still a decision that was taken.
        auditService.record(
            action = AuditAction.STORAGE_PURGE,
            target = area.name.lowercase(),
            detail = if (before == null) {
                "deleted all $deleted rows"
            } else {
                "deleted $deleted rows older than ${request.keepDays} days"
            },
        )
        log.info("Purged {} rows from {}", deleted, table)

        return PurgeResponse(
            area = area,
            deleted = deleted,
            // Read again rather than subtracted: deleting rows barely moves this, which is the
            // thing the screen has to be able to show rather than explain away.
            totalBytes = storage.sizes().filter { it.table == table }.sumOf { it.totalBytes },
        )
    }

    /**
     * Rewrites every table so that deleted rows stop occupying disk.
     *
     * **Locks each table exclusively while it runs**, which is why it is a button rather than
     * something a purge does silently. On a live deployment it stalls hosts reporting and browsers
     * reading for as long as the largest table takes to rewrite.
     *
     * Deliberately not transactional, and it cannot be: Postgres refuses `VACUUM` inside a
     * transaction block. The audit entry is written first, in its own, so the record of the attempt
     * survives a vacuum that fails halfway.
     */
    fun reclaim(): ReclaimResponse {
        val before = storage.databaseBytes()
        auditService.record(
            action = AuditAction.STORAGE_PURGE,
            target = "reclaim",
            detail = "rewriting every table to return $before bytes of database to the disk",
        )

        storage.vacuum(storage.sizes().map { it.table })

        val after = storage.databaseBytes()
        log.info("Reclaimed {} bytes", before - after)
        return ReclaimResponse(beforeBytes = before, afterBytes = after)
    }
}

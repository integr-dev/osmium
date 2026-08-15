package net.integr.osmium.schematic.service

import net.integr.osmium.schematic.model.SchematicStatus
import net.integr.osmium.schematic.repository.SchematicRepository
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

/**
 * Squares the rows against the disk, once, on boot.
 *
 * The file and the row it belongs to live in different places and cannot be written atomically, so
 * a process that stops between them leaves them disagreeing. Nothing else will notice: a half
 * upload looks exactly like a paused one, and an interrupted analysis looks exactly like a running
 * one. Both stay that way forever unless something asks.
 *
 * Same shape as the reconciliation a host does when it reconnects, and for the same reason — state
 * that outlives the process that set it needs someone to check it still means what it says.
 */
@Component
class SchematicReconciler(
    private val repository: SchematicRepository,
    private val storage: SchematicStorage,
    private val queue: SchematicAnalysisQueue,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @EventListener(ApplicationReadyEvent::class)
    @Transactional
    fun reconcile() {
        val known = repository.findAll()

        known.forEach { schematic ->
            val id = schematic.id ?: return@forEach
            val onDisk = storage.sizeOf(id)

            when (schematic.status) {
                // The bytes hit the disk before the row was updated, so a crash between them leaves
                // a file longer than the row admits. The row is the authority — those extra bytes
                // were never acknowledged to the client, and it will send them again from the
                // offset it is told.
                SchematicStatus.UPLOADING -> when {
                    !storage.exists(id) && schematic.receivedBytes > 0 -> fail(
                        schematic.id!!,
                        "The partial upload is gone from disk. Start it again."
                    )

                    onDisk > schematic.receivedBytes -> {
                        log.info(
                            "Schematic {} has {} bytes on disk and {} acknowledged; trimming",
                            id, onDisk, schematic.receivedBytes,
                        )
                        storage.truncate(id, schematic.receivedBytes)
                    }

                    // Fewer bytes on disk than acknowledged is the one direction the write order
                    // rules out, so it means something outside Osmium touched the file. Believing
                    // the row here would resume into a hole.
                    onDisk < schematic.receivedBytes -> {
                        log.warn("Schematic {} lost bytes on disk; rewinding to {}", id, onDisk)
                        schematic.receivedBytes = onDisk
                        schematic.updatedAt = Instant.now()
                    }

                    else -> Unit
                }

                // Interrupted mid-pass. The work is idempotent — it reads a file and writes a row —
                // so it simply goes back in the queue.
                SchematicStatus.ANALYSING -> requeue(schematic.id!!)

                // Queued when the process stopped, and the queue was in memory.
                SchematicStatus.PENDING -> requeue(schematic.id!!)

                // A schematic whose file has gone lists, opens, and fails at everything that
                // matters. Better to say so than to let it be chosen for a build.
                SchematicStatus.READY -> if (!storage.exists(id)) {
                    fail(id, "The file is missing from storage. Upload it again.")
                }

                SchematicStatus.FAILED -> Unit
            }
        }

        sweepOrphans(known.mapNotNull { it.id }.toSet())
    }

    /**
     * Deletes files no row owns.
     *
     * The residue of an upload that died between creating the file and committing the row. Nothing
     * will ever look at them again, and they are the size of the uploads that failed — so without
     * this the volume fills with exactly the files nobody wanted.
     */
    private fun sweepOrphans(known: Set<Long>) {
        val orphans = storage.storedIds() - known
        orphans.forEach { id ->
            log.info("Removing schematic file {}, which no row owns", id)
            storage.delete(id)
        }
    }

    private fun requeue(id: Long) {
        repository.findById(id).ifPresent { schematic ->
            schematic.status = SchematicStatus.PENDING
            schematic.analysedBytes = 0
            schematic.updatedAt = Instant.now()
        }
        queue.enqueue(id)
    }

    private fun fail(id: Long, reason: String) {
        repository.findById(id).ifPresent { schematic ->
            schematic.status = SchematicStatus.FAILED
            schematic.failure = reason
            schematic.updatedAt = Instant.now()
        }
    }
}

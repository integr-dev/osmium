package net.integr.osmium.schematic.service

import jakarta.annotation.PreDestroy
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.schematic.config.SchematicProperties
import net.integr.osmium.schematic.dto.toResponse
import net.integr.osmium.schematic.repository.SchematicRepository
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One schematic read at a time.
 *
 * Deliberately serial. A pass is minutes of streaming decompression pinning a core, and two at once
 * on the same machine do not finish in half the time — they finish in rather more than the sum,
 * having spent the difference contending for the same disk. Queued, the second one waits and the
 * first one is done sooner.
 *
 * The queue is in memory and the durable record is the row's status, which is what makes a restart
 * survivable: anything left `ANALYSING` was interrupted, and [SchematicReconciler] puts it back.
 *
 * It also announces the line it keeps, which is why a broker is here rather than only in the service.
 * A schematic's own row cannot say where it is waiting — the answer changes when a *different*
 * schematic is taken, and nothing touches the waiting row when that happens. Only the queue knows
 * the moment the order shifts, so only the queue can say so.
 */
@Component
class SchematicAnalysisQueue(
    /**
     * Lazily, because the analyser depends on the service that depends on this. A queue that
     * nothing has handed work to yet has no need of a worker either.
     */
    private val analyser: ObjectProvider<SchematicAnalyser>,
    private val repository: SchematicRepository,
    private val properties: SchematicProperties,
    private val broker: LiveUpdateBroker,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    private val pending = LinkedBlockingQueue<Long>()
    private val running = AtomicBoolean(true)

    /**
     * Held while the line is described. Never held across [LinkedBlockingQueue.take], which blocks
     * until there is work — that would be a worker holding a lock for as long as the queue is empty.
     */
    private val line = Any()

    private val worker = Thread { work() }.apply {
        name = "schematic-analysis"
        // A daemon: an analysis that is still running when the process is asked to stop should not
        // be the reason it does not. The row stays ANALYSING and the next boot picks it up.
        isDaemon = true
        start()
    }

    /**
     * Queues a schematic, **after the caller's transaction commits**.
     *
     * The worker is another thread reading the same database, so it cannot see a row that is still
     * inside an open transaction. Handed the id directly, it wins the race often enough to matter:
     * it looks the schematic up, finds it missing or still `UPLOADING`, decides there is nothing to
     * do, and drops it — and because the queue is the only thing that would have come back to it,
     * the upload sits at `PENDING` until the next restart notices.
     *
     * Same reasoning as the live-update broker, which defers publishing for the same reason.
     */
    fun enqueue(id: Long) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            join(id)
            return
        }

        TransactionSynchronizationManager.registerSynchronization(
            object : TransactionSynchronization {
                override fun afterCommit() {
                    join(id)
                }
            }
        )
    }

    private fun join(id: Long) = synchronized(line) {
        pending += id
        announce()
    }

    /** How many are waiting, for the tests and for anything that wants to say "3 in queue". */
    fun depth(): Int = pending.size

    /**
     * Where each waiting schematic sits, 1 meaning next to be read.
     *
     * A snapshot rather than a live view: the worker takes from the same queue on another thread, so
     * anything read one id at a time could report two schematics in the same place.
     */
    fun positions(): Map<Long, Int> =
        pending.toList().withIndex().associate { (index, id) -> id to index + 1 }

    fun positionOf(id: Long): Int? = positions()[id]

    /**
     * Tells everyone watching where the waiting schematics now are.
     *
     * Sent for the whole line rather than for the one that moved, because taking the head moves all
     * of them. The line is a handful of entries at worst — the analysis behind it is minutes of
     * work per schematic, so a queue long enough for this to cost anything is a queue nobody is
     * getting to the end of today.
     *
     * **Only ever called holding [line].** Not to protect the queue, which is already thread-safe,
     * but to keep a schematic that has been taken out of what is announced: the reader flips it to
     * `ANALYSING` and says so immediately, and an announcement assembled a moment earlier would
     * arrive afterwards and put a row that is being read back into the line. Under the lock, an id
     * that `take` has returned can never appear in a later announcement.
     */
    private fun announce() {
        val positions = positions()
        if (positions.isEmpty()) return

        repository.findAllById(positions.keys).forEach { schematic ->
            // Immediately, because both callers are already past a commit: one runs in an
            // afterCommit callback, where the ordinary publish would register a synchronization
            // onto a list that has been walked and drop the event without a word, and the other is
            // a worker thread with no transaction at all.
            broker.publishNow(
                LiveUpdateEvent(
                    type = LiveUpdateType.SCHEMATIC_CHANGED,
                    data = schematic.toResponse(properties.maxDataVersion, positions[schematic.id]),
                )
            )
        }
    }

    private fun work() {
        while (running.get()) {
            val id = try {
                pending.take()
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }

            try {
                // Everything behind this one just moved up. Said before the read starts rather
                // than after it, which on a large file is several minutes later — and inside the
                // guard, because a throw on the way to the reader would end the loop, and a dead
                // worker is every upload after it sitting at PENDING for the life of the process.
                synchronized(line) { announce() }
                analyser.getObject().analyse(id)
            } catch (failure: Exception) {
                // The analyser records its own failures on the row. Anything reaching here is the
                // machinery rather than the file, and it must not take the worker with it — one
                // unreadable schematic would otherwise stop every upload after it, silently.
                log.error("Analysis of schematic {} failed outside the reader", id, failure)
            }
        }
    }

    @PreDestroy
    fun stop() {
        running.set(false)
        worker.interrupt()
    }
}

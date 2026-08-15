package net.integr.osmium.schematic.service

import jakarta.annotation.PreDestroy
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
 */
@Component
class SchematicAnalysisQueue(
    /**
     * Lazily, because the analyser depends on the service that depends on this. A queue that
     * nothing has handed work to yet has no need of a worker either.
     */
    private val analyser: ObjectProvider<SchematicAnalyser>,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    private val pending = LinkedBlockingQueue<Long>()
    private val running = AtomicBoolean(true)

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
            pending += id
            return
        }

        TransactionSynchronizationManager.registerSynchronization(
            object : TransactionSynchronization {
                override fun afterCommit() {
                    pending += id
                }
            }
        )
    }

    /** How many are waiting, for the tests and for anything that wants to say "3 in queue". */
    fun depth(): Int = pending.size

    private fun work() {
        while (running.get()) {
            val id = try {
                pending.take()
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }

            try {
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

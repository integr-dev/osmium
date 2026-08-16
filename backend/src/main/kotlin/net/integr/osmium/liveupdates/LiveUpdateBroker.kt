package net.integr.osmium.liveupdates

import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Fan-out for [LiveUpdateEvent]s.
 *
 * An interface with one in-memory implementation, deliberately. With two backend instances a host's
 * WebSocket lands on one while a browser's stream sits on the other, and that browser never sees the
 * event — solving it needs a shared broker or sticky routing. Keeping the fan-out behind this makes
 * that a second implementation rather than a rewrite.
 */
interface LiveUpdateBroker {
    fun publish(event: LiveUpdateEvent)

    /**
     * Delivers now, whatever transaction is open.
     *
     * For **progress**, where [publish] is not merely unnecessary but wrong. A unit of work that
     * runs for minutes inside one transaction and reports how far it has got has nothing left to
     * say by the time that transaction commits: deferred, every report lands in one burst at the
     * end, and the whole pass reads as silence followed by a finished job. The schematic reader is
     * the case — it held a browser on "queued" for the entire length of a read.
     *
     * Also the only thing that works from inside an `afterCommit` callback. Synchronizations are
     * still registered there but the list has already been walked, so [publish] would hand the
     * event to a callback that is never invoked and drop it without a word.
     *
     * Not for state changes. Those are what the deferral protects: announcing one that a rollback
     * then discards leaves every client holding a value nothing will ever correct.
     */
    fun publishNow(event: LiveUpdateEvent)

    fun subscribe(listener: (LiveUpdateEvent) -> Unit)
}

@Component
class InMemoryLiveUpdateBroker : LiveUpdateBroker {

    private val log = LoggerFactory.getLogger(javaClass)
    private val listeners = CopyOnWriteArrayList<(LiveUpdateEvent) -> Unit>()

    override fun subscribe(listener: (LiveUpdateEvent) -> Unit) {
        listeners += listener
    }

    /**
     * Publishes **after the surrounding transaction commits**, or immediately when there is none.
     *
     * Emitting inside the transaction would announce changes that a rollback then discards, and a
     * client applying events in place has no way to learn it was told a lie. This is the opposite
     * choice from the audit log, which records inside the transaction precisely so that an entry
     * exists only if the command committed — same principle, different mechanism.
     */
    override fun publish(event: LiveUpdateEvent) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            deliver(event)
            return
        }
        TransactionSynchronizationManager.registerSynchronization(
            object : TransactionSynchronization {
                override fun afterCommit() = deliver(event)
            },
        )
    }

    override fun publishNow(event: LiveUpdateEvent) = deliver(event)

    private fun deliver(event: LiveUpdateEvent) {
        for (listener in listeners) {
            // One failing subscriber must not stop the others from being told.
            runCatching { listener(event) }
                .onFailure { log.warn("Live update listener failed for {}", event.type, it) }
        }
    }
}

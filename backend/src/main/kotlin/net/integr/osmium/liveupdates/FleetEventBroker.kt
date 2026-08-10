package net.integr.osmium.liveupdates

import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Fan-out for [FleetEvent]s.
 *
 * An interface with one in-memory implementation, deliberately. With two backend instances a host's
 * WebSocket lands on one while a browser's stream sits on the other, and that browser never sees the
 * event — solving it needs a shared broker or sticky routing. Keeping the fan-out behind this makes
 * that a second implementation rather than a rewrite.
 */
interface FleetEventBroker {
    fun publish(event: FleetEvent)

    fun subscribe(listener: (FleetEvent) -> Unit)
}

@Component
class InMemoryFleetEventBroker : FleetEventBroker {

    private val log = LoggerFactory.getLogger(javaClass)
    private val listeners = CopyOnWriteArrayList<(FleetEvent) -> Unit>()

    override fun subscribe(listener: (FleetEvent) -> Unit) {
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
    override fun publish(event: FleetEvent) {
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

    private fun deliver(event: FleetEvent) {
        for (listener in listeners) {
            // One failing subscriber must not stop the others from being told.
            runCatching { listener(event) }
                .onFailure { log.warn("Fleet event listener failed for {}", event.type, it) }
        }
    }
}

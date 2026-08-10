package net.integr.osmium.stream

import jakarta.annotation.PostConstruct
import net.integr.osmium.repository.UserRepository
import net.integr.osmium.security.Nodes
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Open browser streams, and the only thing that writes to them.
 *
 * Subscribes to the broker **once** and fans out here, rather than registering one broker listener
 * per client: the broker then has no idea how many browsers exist, which is what keeps a future
 * shared-broker implementation from having to care.
 */
@Component
class StreamRegistry(
    private val broker: FleetEventBroker,
    private val userRepository: UserRepository,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val subscriptions = CopyOnWriteArrayList<Subscription>()

    /**
     * @param agentId when set, the stream carries only that agent's events. Fanning everything to
     *   everyone wastes the wire and leaks activity across views nobody is looking at.
     */
    private class Subscription(
        val emitter: SseEmitter,
        val username: String,
        val expiresAt: Instant?,
        val agentId: Long?,
    )

    @PostConstruct
    fun start() {
        broker.subscribe(::dispatch)
    }

    fun open(username: String, expiresAt: Instant?, agentId: Long? = null): SseEmitter {
        // The stream must not outlive the token that opened it, so the emitter's own timeout is the
        // token's remaining life. Without an expiry it falls back to a bounded default rather than
        // running forever.
        val timeoutMillis = expiresAt
            ?.let { (it.toEpochMilli() - System.currentTimeMillis()).coerceAtLeast(0) }
            ?: DEFAULT_TIMEOUT_MILLIS
        val emitter = SseEmitter(timeoutMillis)

        val subscription = Subscription(emitter, username, expiresAt, agentId)
        subscriptions += subscription

        emitter.onCompletion { subscriptions.remove(subscription) }
        emitter.onTimeout { subscriptions.remove(subscription) }
        emitter.onError { subscriptions.remove(subscription) }

        // Proves the stream is live before anything happens on it, so a client can distinguish
        // "connected and quiet" from "still connecting".
        runCatching { emitter.send(SseEmitter.event().name("ready").data("{}")) }
        return emitter
    }

    private fun dispatch(event: FleetEvent) {
        for (subscription in subscriptions) {
            if (!matches(subscription, event)) continue
            send(subscription) {
                it.send(SseEmitter.event().name(event.type.eventName).data(event.data))
            }
        }
    }

    /** A per-agent stream sees only its own agent; the fleet stream sees everything. */
    private fun matches(subscription: Subscription, event: FleetEvent): Boolean =
        subscription.agentId == null || subscription.agentId == event.agentId

    /**
     * Re-checks authority and keeps connections alive.
     *
     * Authorities resolve from the database on every REST request, so a demotion takes effect
     * immediately — but a stream authorises once at subscribe and then runs for hours. This is the
     * one place that guarantee would otherwise leak, so it is closed here rather than documented as
     * a caveat.
     */
    @Scheduled(fixedDelay = TICK_MILLIS)
    @Transactional(readOnly = true)
    fun tick() {
        val now = Instant.now()
        for (subscription in subscriptions) {
            if (subscription.expiresAt != null && !now.isBefore(subscription.expiresAt)) {
                close(subscription, "token expired")
                continue
            }
            if (!stillAuthorised(subscription.username)) {
                close(subscription, "no longer holds ${Nodes.FLEET_READ}")
                continue
            }
            // A comment frame, which SSE ignores. Without it an idle stream is indistinguishable
            // from a dead one to any proxy in the path.
            send(subscription) { it.send(SseEmitter.event().comment("keep-alive")) }
        }
    }

    private fun stillAuthorised(username: String): Boolean =
        userRepository.findAuthorization(username).any { it.nodeId == Nodes.FLEET_READ }

    private fun close(subscription: Subscription, reason: String) {
        log.debug("Closing stream for {}: {}", subscription.username, reason)
        subscriptions.remove(subscription)
        runCatching { subscription.emitter.complete() }
    }

    /** A client that has gone away is a normal event, not an error worth logging per message. */
    private fun send(subscription: Subscription, block: (SseEmitter) -> Unit) {
        try {
            block(subscription.emitter)
        } catch (failure: IOException) {
            subscriptions.remove(subscription)
            runCatching { subscription.emitter.complete() }
            log.trace("Dropped stream for {}", subscription.username, failure)
        } catch (failure: IllegalStateException) {
            // Already completed by a concurrent timeout or close.
            subscriptions.remove(subscription)
            log.trace("Stream for {} was already closed", subscription.username, failure)
        }
    }

    private companion object {
        const val TICK_MILLIS = 30_000L
        const val DEFAULT_TIMEOUT_MILLIS = 3_600_000L
    }
}

package net.integr.osmium.hostlink

import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * How many bytes each host moves, on the two links it has.
 *
 * - **The host link** is the socket to this backend. Counted here, as frames pass, so it needs
 *   nothing from the host and cannot disagree with what actually crossed the wire.
 * - **The game link** is every agent's connection to its Minecraft server. Only the host can see
 *   those, so it reports running totals on its heartbeat and a rate is worked out from two of them.
 *
 * Totals only, never a series. [net.integr.osmium.dashboard.service.DashboardHistory] samples these
 * on its own tick; keeping a second history here would be two clocks disagreeing about one number.
 */
@Component
class HostTraffic(private val clock: Clock = Clock.systemUTC()) {

    private val links = ConcurrentHashMap<Long, Totals>()
    private val games = ConcurrentHashMap<Long, Report>()

    fun sent(hostId: Long, bytes: Int) {
        links.computeIfAbsent(hostId) { Totals() }.sent.addAndGet(bytes.toLong())
    }

    fun received(hostId: Long, bytes: Int) {
        links.computeIfAbsent(hostId) { Totals() }.received.addAndGet(bytes.toLong())
    }

    /** Bytes to and from each host since this backend started, keyed by host. */
    fun linkTotals(): Map<Long, Pair<Long, Long>> =
        links.mapValues { (_, totals) -> totals.sent.get() to totals.received.get() }

    /**
     * A host's running game totals, as its heartbeat carries them.
     *
     * A total lower than the last one means the host restarted and began counting again, so that
     * report sets a new baseline rather than producing a negative rate.
     */
    fun reported(hostId: Long, sent: Long, received: Long) {
        val now = clock.instant()
        games.compute(hostId) { _, previous ->
            val seconds = previous?.let { Duration.between(it.at, now).toMillis() / 1000.0 } ?: 0.0
            val rates = if (previous == null || seconds <= 0 || sent < previous.sent || received < previous.received) {
                0L to 0L
            } else {
                ((sent - previous.sent) / seconds).toLong() to ((received - previous.received) / seconds).toLong()
            }
            Report(sent, received, now, rates)
        }
    }

    /**
     * Bytes per second each host's agents are sending and receiving, from the last two heartbeats.
     *
     * A host whose last report is older than a heartbeat's grace is left out rather than held at its
     * last rate: it has stopped saying anything, and a flat line at yesterday's traffic would say it
     * is still busy.
     */
    fun gameRates(): Map<Long, Pair<Long, Long>> {
        val now = clock.instant()
        return games
            .filterValues { Duration.between(it.at, now) <= FRESH_FOR }
            .mapValues { (_, report) -> report.rates }
    }

    fun forget(hostId: Long) {
        links.remove(hostId)
        games.remove(hostId)
    }

    private class Totals {
        val sent = AtomicLong()
        val received = AtomicLong()
    }

    private data class Report(val sent: Long, val received: Long, val at: Instant, val rates: Pair<Long, Long>)

    private companion object {
        /** Matches [net.integr.osmium.host.model.Host.HEARTBEAT_GRACE]. */
        val FRESH_FOR: Duration = Duration.ofSeconds(30)
    }
}

package net.integr.osmium.hostlink

import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * What each host is costing the machine it runs on, as of its last heartbeat.
 *
 * **Levels, not totals** - which is the whole difference from [HostTraffic] beside it. Bytes moved
 * are counted so a missed heartbeat loses none of them; processor use is a rate the host has
 * already worked out over its own last interval, and adding up rates would describe an hour that
 * has gone rather than the moment being charted.
 *
 * The latest reading only, never a series, for the same reason [HostTraffic] keeps none:
 * [net.integr.osmium.dashboard.service.DashboardHistory] samples on its own tick, and a second
 * history here would be two clocks disagreeing about one number.
 */
@Component
class HostUsage(private val clock: Clock = Clock.systemUTC()) {

    private val reports = ConcurrentHashMap<Long, Report>()

    fun reported(
        hostId: Long,
        cpu: Double,
        memory: Long,
        systemCpu: Double,
        systemMemory: Long,
        systemMemoryTotal: Long,
    ) {
        reports[hostId] = Report(cpu, memory, systemCpu, systemMemory, systemMemoryTotal, clock.instant())
    }

    /**
     * The latest reading per host, leaving out anyone who has gone quiet.
     *
     * A host whose last heartbeat is older than the grace is dropped rather than held at its last
     * reading, the rule the traffic rates follow: a flat line at yesterday's processor use says the
     * machine is still working, which is the one thing it is not doing.
     */
    fun latest(): Map<Long, Report> {
        val now = clock.instant()
        return reports.filterValues { Duration.between(it.at, now) <= FRESH_FOR }
    }

    fun forget(hostId: Long) {
        reports.remove(hostId)
    }

    /**
     * One host's processor and memory at one moment.
     *
     * [cpu] is a percentage of a single core, so a host working two of them flat out reports 200;
     * [systemCpu] is a percentage of the whole machine, so it never passes 100. Two scales because
     * they answer two questions - what Osmium costs, and whether the box has anything left - and
     * putting them on one would make the first unreadable on a machine with sixteen cores.
     */
    data class Report(
        val cpu: Double,
        val memory: Long,
        val systemCpu: Double,
        val systemMemory: Long,
        val systemMemoryTotal: Long,
        val at: Instant,
    )

    private companion object {
        /** Matches [HostTraffic.FRESH_FOR] and [net.integr.osmium.host.model.Host.HEARTBEAT_GRACE]. */
        val FRESH_FOR: Duration = Duration.ofSeconds(30)
    }
}

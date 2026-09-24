package net.integr.osmium.dashboard.service

import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildJobState
import net.integr.osmium.build.repository.BuildJobRepository
import net.integr.osmium.dashboard.dto.DashboardReadingResponse
import net.integr.osmium.dashboard.dto.DashboardSampleResponse
import net.integr.osmium.dashboard.dto.HostTrafficResponse
import net.integr.osmium.host.repository.HostRepository
import net.integr.osmium.hostlink.HostTraffic
import net.integr.osmium.hostlink.HostUsage
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Clock
import java.time.Duration
import java.time.Instant

/**
 * The last six hours of the dashboard, one point every ten seconds.
 *
 * **In memory, and deliberately so.** Every figure here is either already stored (agents, jobs) or
 * worthless an hour later (traffic), so a table would be a retention policy guarding numbers that
 * can be recomputed. What this buys over the browser sampling on its own is that a reload, or a
 * second tab, opens on six hours of trend rather than an empty chart. A backend restart still
 * starts one, and the dashboard says so.
 *
 * Each point is pushed as it is taken, so an open dashboard appends rather than polls.
 */
@Service
class DashboardHistory(
    private val agentRepository: AgentRepository,
    private val jobRepository: BuildJobRepository,
    private val hostRepository: HostRepository,
    private val traffic: HostTraffic,
    private val usage: HostUsage,
    private val broker: LiveUpdateBroker,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val samples = ArrayDeque<DashboardSampleResponse>()

    /** The host link totals at the last point, to turn running totals into a rate. */
    private var lastTotals: Map<Long, Pair<Long, Long>> = emptyMap()
    private var lastAt: Instant? = null

    /** Oldest first. A copy, so a caller can serialise it while the next point is being taken. */
    fun all(): List<DashboardSampleResponse> = synchronized(samples) { samples.toList() }

    @Scheduled(fixedRateString = "\${osmium.dashboard.sample-ms:10000}")
    @Transactional(readOnly = true)
    fun sample() {
        val point = take()
        synchronized(samples) {
            samples.addLast(point)
            while (samples.size > CAPACITY) samples.removeFirst()
        }
        broker.publishNow(LiveUpdateEvent(type = LiveUpdateType.DASHBOARD_SAMPLE, data = point))
    }

    private fun take(): DashboardSampleResponse {
        val now = clock.instant()
        val agents = agentRepository.findAll()
        val jobs = jobRepository.findAll().filter { it.state != BuildJobState.DONE }

        val servers = (agents.mapNotNull { it.serverAddress } + jobs.map { it.serverAddress }).toSortedSet()

        return DashboardSampleResponse(
            at = now,
            fleet = reading(agents, jobs, now),
            servers = servers.associateWith { address ->
                reading(agents.filter { it.serverAddress == address }, jobs.filter { it.serverAddress == address }, now)
            },
            hosts = hosts(now),
        )
    }

    private fun hosts(now: Instant): List<HostTrafficResponse> {
        val totals = traffic.linkTotals()
        val games = traffic.gameRates()
        val loads = usage.latest()
        val links = linkRates(lastTotals, totals, lastAt?.let { Duration.between(it, now) })
        lastTotals = totals
        lastAt = now

        return hostRepository.findAll().sortedBy { it.name }.map { host ->
            val id = host.id!!
            val link = links[id] ?: (0L to 0L)
            val game = games[id]
            val load = loads[id]
            HostTrafficResponse(
                hostId = id,
                name = host.name,
                reachable = host.isReachable(now),
                linkSent = link.first,
                linkReceived = link.second,
                gameSent = game?.first,
                gameReceived = game?.second,
                cpu = load?.cpu,
                memory = load?.memory,
                systemCpu = load?.systemCpu,
                systemMemory = load?.systemMemory,
                systemMemoryTotal = load?.systemMemoryTotal,
            )
        }
    }

    companion object {
        /** Six hours at the default ten seconds. */
        const val CAPACITY = 6 * 60 * 6

        /**
         * Bytes a second per host between two sets of running totals.
         *
         * A host with no earlier total reads zero rather than its whole history divided by ten
         * seconds, which is what the first point after a start or a reconnect would otherwise draw.
         */
        fun linkRates(
            before: Map<Long, Pair<Long, Long>>,
            after: Map<Long, Pair<Long, Long>>,
            elapsed: Duration?,
        ): Map<Long, Pair<Long, Long>> {
            val seconds = (elapsed?.toMillis() ?: 0) / 1000.0
            return after.mapValues { (hostId, now) ->
                val then = before[hostId]
                if (then == null || seconds <= 0) 0L to 0L
                else ((now.first - then.first) / seconds).toLong() to ((now.second - then.second) / seconds).toLong()
            }
        }

        /**
         * The same figures the browser used to work out for itself - see `jobFigures` in the
         * frontend - so the chart and the tile above it cannot disagree.
         */
        fun reading(agents: List<Agent>, jobs: List<BuildJob>, now: Instant): DashboardReadingResponse {
            val working = jobs.filter { it.state == BuildJobState.ACTIVE }
            val minutes = working.sumOf { maxOf(0.0, Duration.between(it.startedAt, now).toMillis() / 60_000.0) }
            val placedByWorking = working.sumOf { it.blocksPlaced }

            return DashboardReadingResponse(
                // `effectiveState`, but at the moment this point is for rather than whenever it runs.
                online = agents.count { it.state == AgentState.ONLINE && it.host.isReachable(now) },
                agents = agents.size,
                placed = jobs.sumOf { it.blocksPlaced },
                total = jobs.sumOf { it.totalBlocks },
                perMinute = if (minutes >= MEASURABLE_MINUTES) Math.round(placedByWorking / minutes) else 0,
            )
        }

        /** Below this the elapsed time is too short to divide by and mean anything. */
        private const val MEASURABLE_MINUTES = 0.25
    }
}

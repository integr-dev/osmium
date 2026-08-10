package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentTelemetryResponse
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * The latest sample each agent reported. **In memory, latest wins, never written to Postgres.**
 *
 * Telemetry is the only thing here with no historical value and by far the highest write volume - a
 * row per agent per tick, forever, to answer questions nobody asks. Keeping it out of the database
 * also means a restart cannot resurrect a position from an hour ago and render it as current.
 *
 * **A sample goes stale rather than being cleared.** Nothing pushes an event when a host falls
 * silent - `STALE` is itself derived from the heartbeat rather than reported - so any design that
 * relied on being *told* to forget would leave last-known vitals on screen indefinitely, presented
 * as current. Ageing out needs no notification and no cleanup path, and it is the same pattern
 * `Host.isReachable` already uses.
 */
@Component
class AgentTelemetryStore(private val clock: Clock = Clock.systemUTC()) {

    private val samples = ConcurrentHashMap<Long, Sample>()

    fun record(agentId: Long, telemetry: AgentTelemetryResponse) {
        samples[agentId] = Sample(telemetry, clock.instant())
    }

    /** The agent's current telemetry, or null when it has not reported recently enough to trust. */
    fun find(agentId: Long?): AgentTelemetryResponse? {
        val sample = samples[agentId ?: return null] ?: return null
        if (Duration.between(sample.at, clock.instant()) > FRESH_FOR) {
            // Dropped on read, so a fleet that goes quiet does not hold its last samples forever.
            samples.remove(agentId)
            return null
        }
        return sample.telemetry
    }

    /** Called when an agent is deleted, so the map cannot outgrow the fleet. */
    fun forget(agentId: Long) {
        samples.remove(agentId)
    }

    private data class Sample(val telemetry: AgentTelemetryResponse, val at: Instant)

    private companion object {
        /**
         * Matches [net.integr.osmium.host.model.Host.HEARTBEAT_GRACE]. An agent whose host has gone
         * quiet long enough to read as STALE must not still be showing 20 health.
         */
        val FRESH_FOR: Duration = Duration.ofSeconds(30)
    }
}

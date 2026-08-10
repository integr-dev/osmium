package net.integr.osmium.agent.service

import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import java.util.concurrent.ConcurrentHashMap

/**
 * Pushes telemetry to the browser on a fixed tick rather than once per reported sample.
 *
 * **Coalescing, not forwarding.** Chat lines and state transitions are human-paced and can go out as
 * they arrive. Position and health cannot: a fleet of 200 agents reporting every five seconds is 40
 * events a second on every open stream, each one re-rendering a row because someone moved a block.
 * Coalescing turns that into one event per agent per tick regardless of how often it reports.
 *
 * It costs nothing to do it this way because [AgentTelemetryStore] already keeps only the latest
 * value: this holds a set of agent ids with something new to say, not a queue of samples, so a burst
 * of reports collapses into one publish carrying the newest reading rather than a backlog of stale
 * ones the browser would render and immediately overwrite.
 */
@Component
class AgentTelemetryPublisher(
    private val telemetryStore: AgentTelemetryStore,
    private val broker: FleetEventBroker,
) {
    /** Ids only. What to send is looked up at publish time, so it is never a tick out of date. */
    private val pending = ConcurrentHashMap.newKeySet<Long>()

    fun reported(agentId: Long) {
        pending.add(agentId)
    }

    fun forget(agentId: Long) {
        pending.remove(agentId)
    }

    @Scheduled(fixedDelay = TICK_MS)
    fun flush() {
        if (pending.isEmpty()) return

        // Cleared before publishing, not after: a sample arriving mid-flush re-marks its agent and
        // goes out on the next tick. Clearing afterwards would drop it silently.
        val due = pending.toList()
        pending.removeAll(due.toSet())

        for (agentId in due) {
            // Null when the sample aged out between being reported and this tick, which is not worth
            // announcing - the agent has already stopped reporting.
            val telemetry = telemetryStore.find(agentId) ?: continue
            broker.publish(
                FleetEvent(
                    type = FleetEventType.AGENT_TELEMETRY,
                    data = mapOf("agentId" to agentId, "telemetry" to telemetry),
                    agentId = agentId,
                ),
            )
        }
    }

    private companion object {
        /**
         * Fast enough that vitals feel live, slow enough to decouple the browser from however often
         * hosts happen to report. Worth revisiting against real host traffic - it is the one number
         * here that trades responsiveness against event volume.
         */
        const val TICK_MS = 1_000L
    }
}

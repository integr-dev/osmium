package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentTelemetryResponse
import net.integr.osmium.agent.dto.PositionResponse
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateType
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Coalescing is the whole point, so these are about what does *not* go out: a burst of reports has
 * to collapse into one event carrying the newest reading, not a backlog the browser would render
 * and immediately overwrite.
 */
class AgentTelemetryPublisherTest {

    private class TestClock(var now: Instant) : Clock() {
        override fun instant(): Instant = now
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock = this
        fun advance(by: Duration) {
            now = now.plus(by)
        }
    }

    /** Collects instead of fanning out, so a test can assert on exactly what was published. */
    private class RecordingBroker : LiveUpdateBroker {
        val published = mutableListOf<LiveUpdateEvent>()
        override fun publish(event: LiveUpdateEvent) {
            published += event
        }

        override fun subscribe(listener: (LiveUpdateEvent) -> Unit) = Unit

        fun telemetryFor(agentId: Long) = published
            .filter { it.type == LiveUpdateType.AGENT_TELEMETRY && it.agentId == agentId }
    }

    private fun sample(health: Int) = AgentTelemetryResponse(
        health = health,
        food = 20,
        position = PositionResponse(0.0, 64.0, 0.0),
        dimension = "overworld",
        pingMs = 30,
        nearby = emptyList(),
    )

    private fun healthOf(event: LiveUpdateEvent): Int {
        val data = event.data as Map<*, *>
        return (data["telemetry"] as AgentTelemetryResponse).health
    }

    private class Fixture {
        val clock = TestClock(Instant.parse("2026-08-10T12:00:00Z"))
        val store = AgentTelemetryStore(clock)
        val broker = RecordingBroker()
        val publisher = AgentTelemetryPublisher(store, broker)
    }

    /** What `HostReportService` does on receipt: store the sample, mark the agent as having news. */
    private fun report(fixture: Fixture, agentId: Long, health: Int) {
        fixture.store.record(agentId, sample(health))
        fixture.publisher.reported(agentId)
    }

    @Test
    fun `a report publishes nothing until the tick`() {
        val fixture = Fixture()

        report(fixture, 1L, 20)

        assertTrue(fixture.broker.published.isEmpty())
    }

    /** The reason this exists: however fast a host reports, the browser hears from it once a tick. */
    @Test
    fun `a burst collapses into one event carrying the newest reading`() {
        val fixture = Fixture()

        report(fixture, 1L, 20)
        report(fixture, 1L, 14)
        report(fixture, 1L, 3)
        fixture.publisher.flush()

        val events = fixture.broker.telemetryFor(1L)
        assertEquals(1, events.size)
        assertEquals(3, healthOf(events.single()))
    }

    @Test
    fun `each agent gets its own event`() {
        val fixture = Fixture()

        report(fixture, 1L, 20)
        report(fixture, 2L, 8)
        fixture.publisher.flush()

        assertEquals(2, fixture.broker.published.size)
        assertEquals(20, healthOf(fixture.broker.telemetryFor(1L).single()))
        assertEquals(8, healthOf(fixture.broker.telemetryFor(2L).single()))
    }

    /** An idle fleet must not put an empty event on every stream once a second. */
    @Test
    fun `a tick with nothing new publishes nothing`() {
        val fixture = Fixture()
        report(fixture, 1L, 20)
        fixture.publisher.flush()

        fixture.publisher.flush()
        fixture.publisher.flush()

        assertEquals(1, fixture.broker.published.size)
    }

    @Test
    fun `a report after a tick goes out on the next one`() {
        val fixture = Fixture()
        report(fixture, 1L, 20)
        fixture.publisher.flush()

        report(fixture, 1L, 9)
        fixture.publisher.flush()

        assertEquals(listOf(20, 9), fixture.broker.telemetryFor(1L).map(::healthOf))
    }

    /** Nothing to announce: the agent has already stopped reporting, which the UI derives itself. */
    @Test
    fun `a sample that aged out before the tick is not published`() {
        val fixture = Fixture()
        report(fixture, 1L, 20)

        fixture.clock.advance(Duration.ofSeconds(31))
        fixture.publisher.flush()

        assertTrue(fixture.broker.published.isEmpty())
    }

    @Test
    fun `forgetting an agent drops its pending tick`() {
        val fixture = Fixture()
        report(fixture, 1L, 20)

        fixture.publisher.forget(1L)
        fixture.publisher.flush()

        assertTrue(fixture.broker.published.isEmpty())
    }
}

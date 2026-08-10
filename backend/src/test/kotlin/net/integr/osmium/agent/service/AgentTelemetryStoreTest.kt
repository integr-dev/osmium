package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentTelemetryResponse
import net.integr.osmium.agent.dto.PositionResponse
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The ageing rule, on a clock the test owns. Staleness is the whole reason this store exists rather
 * than a column, and it is not something to verify by sleeping for thirty seconds.
 */
class AgentTelemetryStoreTest {

    private class TestClock(var now: Instant) : Clock() {
        override fun instant(): Instant = now
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock = this
        fun advance(by: Duration) {
            now = now.plus(by)
        }
    }

    private fun sample(health: Int = 20) = AgentTelemetryResponse(
        health = health,
        food = 20,
        position = PositionResponse(0.0, 64.0, 0.0),
        dimension = "overworld",
        pingMs = 30,
        nearby = emptyList(),
    )

    private fun store(): Pair<AgentTelemetryStore, TestClock> {
        val clock = TestClock(Instant.parse("2026-08-10T12:00:00Z"))
        return AgentTelemetryStore(clock) to clock
    }

    @Test
    fun `the latest sample wins`() {
        val (store, _) = store()

        store.record(1L, sample(health = 20))
        store.record(1L, sample(health = 4))

        assertEquals(4, store.find(1L)?.health)
    }

    /**
     * Nothing tells the backend an agent stopped reporting — a host falling silent fires no event,
     * since STALE is itself derived. Without ageing, last-known vitals would sit on screen forever
     * presented as current.
     */
    @Test
    fun `a sample nobody refreshed goes stale rather than lingering`() {
        val (store, clock) = store()
        store.record(1L, sample())

        clock.advance(Duration.ofSeconds(29))
        assertNotNull(store.find(1L))

        clock.advance(Duration.ofSeconds(2))
        assertNull(store.find(1L))
    }

    @Test
    fun `a fresh report revives an agent that had gone quiet`() {
        val (store, clock) = store()
        store.record(1L, sample())
        clock.advance(Duration.ofMinutes(5))
        assertNull(store.find(1L))

        store.record(1L, sample(health = 11))

        assertEquals(11, store.find(1L)?.health)
    }

    @Test
    fun `an unknown agent has nothing, and neither does a null id`() {
        val (store, _) = store()

        assertNull(store.find(99L))
        assertNull(store.find(null))
    }

    @Test
    fun `forgetting an agent drops its sample`() {
        val (store, _) = store()
        store.record(1L, sample())

        store.forget(1L)

        assertNull(store.find(1L))
    }
}

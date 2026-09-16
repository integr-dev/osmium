package net.integr.osmium.hostlink

import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertNull

class HostTrafficTest {

    private class TestClock(var now: Instant) : Clock() {
        override fun instant(): Instant = now
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock = this
        fun advance(by: Duration) {
            now = now.plus(by)
        }
    }

    private val clock = TestClock(Instant.parse("2026-09-16T12:00:00Z"))
    private val traffic = HostTraffic(clock)

    @Test
    fun `link bytes add up per host and direction`() {
        traffic.sent(1, 100)
        traffic.sent(1, 50)
        traffic.received(1, 7)
        traffic.received(2, 3)

        assertEquals(150L to 7L, traffic.linkTotals()[1])
        assertEquals(0L to 3L, traffic.linkTotals()[2])
    }

    @Test
    fun `a game rate comes from two heartbeats`() {
        traffic.reported(1, sent = 1_000, received = 10_000)
        assertEquals(0L to 0L, traffic.gameRates()[1], "one total is not a rate")

        clock.advance(Duration.ofSeconds(10))
        traffic.reported(1, sent = 3_000, received = 60_000)

        assertEquals(200L to 5_000L, traffic.gameRates()[1])
    }

    @Test
    fun `a host that restarted starts a new baseline instead of a negative rate`() {
        traffic.reported(1, sent = 5_000, received = 5_000)
        clock.advance(Duration.ofSeconds(10))
        traffic.reported(1, sent = 10, received = 20)

        assertEquals(0L to 0L, traffic.gameRates()[1])

        clock.advance(Duration.ofSeconds(10))
        traffic.reported(1, sent = 110, received = 1_020)
        assertEquals(10L to 100L, traffic.gameRates()[1])
    }

    @Test
    fun `a host that stopped reporting has no rate`() {
        traffic.reported(1, sent = 0, received = 0)
        clock.advance(Duration.ofSeconds(10))
        traffic.reported(1, sent = 100, received = 100)

        clock.advance(Duration.ofSeconds(31))

        assertNull(traffic.gameRates()[1])
    }
}

package net.integr.osmium.hostlink

import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What each host costs its machine, as of its last heartbeat.
 *
 * The interesting behaviour is the *forgetting*. A level is only true at the moment it was taken,
 * so a host that has gone quiet must drop out rather than sit at its last reading — a flat line at
 * yesterday's processor use says the machine is still working, which is the one thing it is not
 * doing. The clock is injected so that can be tested without waiting thirty seconds.
 */
class HostUsageTest {

    private val start = Instant.parse("2026-09-24T12:00:00Z")

    private fun at(seconds: Long) = Clock.fixed(start.plusSeconds(seconds), ZoneOffset.UTC)

    @Test
    fun `the latest reading is what the host last said`() {
        val usage = HostUsage(at(0))

        usage.reported(1, cpu = 12.5, memory = 300_000_000, systemCpu = 44.0, systemMemory = 8_000_000_000, systemMemoryTotal = 16_000_000_000)

        val report = usage.latest()[1]
        assertEquals(12.5, report?.cpu)
        assertEquals(300_000_000, report?.memory)
        assertEquals(44.0, report?.systemCpu)
        assertEquals(8_000_000_000, report?.systemMemory)
        assertEquals(16_000_000_000, report?.systemMemoryTotal)
    }

    @Test
    fun `a newer reading replaces the one before it`() {
        val usage = HostUsage(at(0))

        usage.reported(1, 12.5, 1, 44.0, 1, 2)
        usage.reported(1, 90.0, 2, 80.0, 2, 2)

        assertEquals(90.0, usage.latest()[1]?.cpu)
    }

    /**
     * Thirty seconds, matching the heartbeat grace a host is called unreachable after. A reading
     * that survived its host going quiet would be the dashboard asserting something nobody said.
     */
    @Test
    fun `a host that has gone quiet drops out rather than holding its last reading`() {
        var clock = at(0)
        val usage = HostUsage(object : Clock() {
            override fun instant(): Instant = clock.instant()
            override fun getZone() = ZoneOffset.UTC
            override fun withZone(zone: java.time.ZoneId) = this
        })

        usage.reported(1, 12.5, 1, 44.0, 1, 2)
        assertTrue(usage.latest().containsKey(1))

        clock = at(Duration.ofSeconds(29).seconds)
        assertTrue(usage.latest().containsKey(1), "still inside the grace")

        clock = at(Duration.ofSeconds(31).seconds)
        assertNull(usage.latest()[1], "past it, and saying nothing rather than something stale")
    }

    @Test
    fun `a host that is gone takes its reading with it`() {
        val usage = HostUsage(at(0))

        usage.reported(1, 12.5, 1, 44.0, 1, 2)
        usage.forget(1)

        assertNull(usage.latest()[1])
    }
}

package net.integr.osmium.viewer

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

/**
 * The ticket is the whole authorization story for a viewer socket, so what it refuses matters more
 * than what it allows. On an injected clock: expiry is the half that cannot be tested by waiting.
 */
class ViewerTicketsTest {

    private class Tick(var at: Instant) : Clock() {
        override fun instant() = at
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: java.time.ZoneId) = this
    }

    private val clock = Tick(Instant.parse("2026-01-01T00:00:00Z"))
    private val tickets = ViewerTickets(clock)

    @Test
    fun `a freshly minted ticket names who asked for it and which agent`() {
        val spent = tickets.redeem(tickets.mint("ada", 42))

        assertEquals("ada", spent?.username)
        assertEquals(42L, spent?.agentId)
    }

    @Test
    fun `a ticket is good exactly once`() {
        val ticket = tickets.mint("ada", 42)

        assertEquals("ada", tickets.redeem(ticket)?.username)
        assertNull(tickets.redeem(ticket), "a spent ticket must not open a second socket")
    }

    @Test
    fun `a ticket expires`() {
        val ticket = tickets.mint("ada", 42)
        clock.at = clock.at.plus(ViewerTickets.TTL).plusSeconds(1)

        assertNull(tickets.redeem(ticket))
    }

    @Test
    fun `a ticket is still good on the last second of its life`() {
        val ticket = tickets.mint("ada", 42)
        clock.at = clock.at.plus(ViewerTickets.TTL).minusSeconds(1)

        assertEquals(42L, tickets.redeem(ticket)?.agentId)
    }

    @Test
    fun `nothing that was never minted is honoured`() {
        assertNull(tickets.redeem("not-a-ticket"))
        assertNull(tickets.redeem(""))
    }

    @Test
    fun `two tickets are never the same`() {
        assertNotEquals(tickets.mint("ada", 1), tickets.mint("ada", 1))
    }

    @Test
    fun `an expired ticket does not survive being swept`() {
        val stale = tickets.mint("ada", 1)
        clock.at = clock.at.plus(ViewerTickets.TTL).plusSeconds(1)

        // Minting is what sweeps, so this is the moment the stale one is dropped rather than only
        // being refused on redemption.
        val fresh = tickets.mint("ada", 2)

        assertNull(tickets.redeem(stale))
        assertEquals(2L, tickets.redeem(fresh)?.agentId)
    }
}

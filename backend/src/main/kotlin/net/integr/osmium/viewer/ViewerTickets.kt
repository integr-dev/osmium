package net.integr.osmium.viewer

import org.springframework.stereotype.Component
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/**
 * One-shot capabilities to open a viewer socket.
 *
 * A browser cannot set an `Authorization` header on a WebSocket, which is the whole reason this
 * exists - the JWT that would normally authorise the request has no way of reaching the handshake.
 * So the node check happens where it always does, on a REST call, and what comes back is a ticket
 * that stands in for it once.
 *
 * **Deliberately not a token.** It is random, opaque, valid for [TTL], usable exactly once, and
 * bound to the one agent it was minted for. A leaked one buys a few seconds of watching a single
 * agent, which is as small as this could be made without inventing a second signing key.
 *
 * It travels in `Sec-WebSocket-Protocol` rather than the query string: a URL is written to access
 * logs, proxy logs and browser history, and none of those should hold a credential.
 */
@Component
class ViewerTickets(private val clock: Clock = Clock.systemUTC()) {

    private val random = SecureRandom()
    private val issued = ConcurrentHashMap<String, Ticket>()

    data class Ticket(val username: String, val agentId: Long, val expiresAt: Instant)

    fun mint(username: String, agentId: Long): String {
        sweep()
        val bytes = ByteArray(32).also(random::nextBytes)
        val ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        issued[ticket] = Ticket(username, agentId, clock.instant().plus(TTL))
        return ticket
    }

    /**
     * Spends a ticket, or answers null.
     *
     * Removed before it is checked, so a replay loses the race with itself rather than both copies
     * being honoured. An expired one is spent and refused exactly like a forged one.
     */
    fun redeem(ticket: String): Ticket? {
        val found = issued.remove(ticket) ?: return null
        return found.takeIf { clock.instant().isBefore(it.expiresAt) }
    }

    /**
     * Drops what has expired. On mint rather than on a timer: a ticket that is never redeemed is
     * the only way this map grows, and minting is the only thing that grows it.
     */
    private fun sweep() {
        val now = clock.instant()
        issued.values.removeIf { !now.isBefore(it.expiresAt) }
    }

    companion object {
        /** Long enough to open a socket, short enough that a leaked one is worth little. */
        val TTL: Duration = Duration.ofSeconds(30)
    }
}

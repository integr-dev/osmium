package net.integr.osmium.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Table
import java.time.Duration
import java.time.Instant

/**
 * An agent host: a machine running the agent process that owns bots.
 *
 * Holds no Minecraft credentials - see BOT_CONNECTIVITY.md. The enrolment token is stored hashed,
 * like a password, and shown to the operator exactly once.
 */
@Entity
@Table(name = "hosts")
class Host(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @Column(name = "name", nullable = false, unique = true, length = 64)
    var name: String = "",

    @Column(name = "token_hash", nullable = false)
    var tokenHash: String = "",

    /**
     * Observed when the agent dials in, not configured: the agent connects to Osmium, so the
     * backend never needs to reach it. Null until the first connection.
     */
    @Column(name = "address", length = 128)
    var address: String? = null,

    @Column(name = "agent_version", length = 32)
    var agentVersion: String? = null,

    @Column(name = "last_seen_at")
    var lastSeenAt: Instant? = null,
) {
    /**
     * Reachability is derived from the heartbeat rather than stored, so a backend restart cannot
     * leave a host stuck "online". A missed grace window means unreachable, which puts its bots in
     * STALE - not OFFLINE, because we do not actually know whether they are still in game.
     */
    fun isReachable(now: Instant = Instant.now()): Boolean {
        val seen = lastSeenAt ?: return false
        return Duration.between(seen, now) < HEARTBEAT_GRACE
    }

    companion object {
        /** Three missed 10s heartbeats, so a brief blip does not flap the whole fleet. */
        val HEARTBEAT_GRACE: Duration = Duration.ofSeconds(30)
    }
}

package net.integr.osmium.account.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.FetchType
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.Table
import java.time.Instant
import java.util.UUID

/**
 * One issued refresh token.
 *
 * Stored rather than stateless, because the two properties that make a long-lived credential
 * defensible both need server-side state: it can be revoked before it expires, and a token
 * presented twice is evidence that a copy exists somewhere it should not.
 *
 * @param tokenHash SHA-256 of the token value. The value itself is returned once, to a cookie, and
 *   never stored — a database dump yields no usable session.
 * @param family every token minted from one login. Rotation issues a successor in the same family,
 *   so a replayed token can take the whole chain down with it rather than only itself.
 * @param expiresAt inherited unchanged by every successor. The session ends a fixed span after the
 *   login that began it; refreshing does not push it out.
 * @param usedAt when this token was exchanged for its successor. A second presentation of a token
 *   that already has one is the reuse signal — the legitimate holder replaces its cookie and never
 *   replays.
 */
@Entity
@Table(
    name = "refresh_tokens",
    indexes = [
        Index(name = "idx_refresh_tokens_family", columnList = "family"),
        Index(name = "idx_refresh_tokens_expires_at", columnList = "expires_at"),
        Index(name = "idx_refresh_tokens_user_live", columnList = "user_id, issued_at desc"),
    ],
)
class RefreshToken(
    @Column(name = "token_hash", nullable = false, unique = true, length = HASH_LENGTH)
    var tokenHash: String,

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false)
    var user: User,

    @Column(nullable = false)
    var family: UUID,

    @Column(name = "issued_at", nullable = false)
    var issuedAt: Instant,

    @Column(name = "expires_at", nullable = false)
    var expiresAt: Instant,

    /**
     * Where the session was last seen from, and what it was using. Both are only as good as the
     * request that carried them — a user agent is a self-declared string, and the address is only
     * the real client if the deployment's proxy headers are configured; see
     * `server.forward-headers-strategy`. They are here to help an operator recognise their own
     * sessions, not to prove anything about anyone else's.
     *
     * Nullable because they are whatever the request happened to carry. Inventing a value would
     * read as knowledge that is not there.
     */
    @Column(name = "client_ip", length = IP_LENGTH)
    var clientIp: String? = null,

    @Column(name = "user_agent", length = USER_AGENT_LENGTH)
    var userAgent: String? = null,

    @Column(name = "used_at")
    var usedAt: Instant? = null,

    @Column(name = "revoked_at")
    var revokedAt: Instant? = null,

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    var id: Long? = null,
) {
    fun isUsable(now: Instant): Boolean =
        revokedAt == null && usedAt == null && expiresAt.isAfter(now)

    companion object {
        /** Hex-encoded SHA-256. */
        const val HASH_LENGTH = 64

        /** Long enough for IPv6, including a mapped IPv4 form. */
        const val IP_LENGTH = 45
        const val USER_AGENT_LENGTH = 255
    }
}

package net.integr.osmium.account.model

import jakarta.persistence.CascadeType
import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.FetchType
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.OneToMany
import jakarta.persistence.Table
import java.time.Instant

@Entity
@Table(name = "users")
class User(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @Column(name = "username", nullable = false, unique = true, length = 64)
    var username: String = "",

    @Column(name = "password_hash", nullable = false)
    var passwordHash: String = "",

    /**
     * The account's seniority level. Roles are strictly nested - each tier contains the one below
     * it - so holding more than one could never grant more than the highest, and a single
     * assignment keeps the model honest. Null means the account has no permissions at all.
     */
    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "role_id")
    var role: Role? = null,

    /**
     * Stamped into every access token, and compared on every request. Incrementing it refuses every
     * token issued so far.
     *
     * The only way to revoke an access token. One is a stateless JWT with nothing on the server
     * recording that it exists, so there was otherwise no answer to "my laptop was stolen" short of
     * deleting the account — and a password change, which is what people actually reach for, left
     * the thief a full token lifetime to carry on working.
     *
     * A counter rather than a "valid from" timestamp, which is what this was first written as. A
     * JWT's `iat` is whole seconds, so a timestamp has to round, and both directions are wrong:
     * round down and a token issued earlier in the same second survives, round up and signing
     * straight back in rejects the token it has just minted. A version is compared exactly and has
     * no such edge.
     *
     * Checked in [net.integr.osmium.security.DatabaseJwtAuthenticationConverter], inside the query
     * that already resolves authorities, so revocation costs no extra round trip.
     */
    @Column(name = "token_version", nullable = false)
    var tokenVersion: Int = 0,

    /**
     * When a refresh token belonging to this account was last replayed, and when the operator was
     * shown that it had been.
     *
     * The incident already goes to the audit trail, but that needs `audit.read` — so it reaches an
     * administrator and not the person it happened to, who is simply signed out and left to assume
     * the app broke. There is no channel to reach them on, so the notice waits here until they sign
     * in again.
     *
     * Kept as two timestamps rather than clearing the first on acknowledgement: "this happened" and
     * "they were told" are different facts, and a later replay has to be able to raise the notice
     * again without losing the earlier one.
     */
    @Column(name = "session_alert_at")
    var sessionAlertAt: Instant? = null,

    @Column(name = "session_alert_seen_at")
    var sessionAlertSeenAt: Instant? = null,

    /**
     * The account's sessions, live and spent.
     *
     * Mapped for exactly one reason: **deleting an account deletes its sessions**, wherever the
     * delete comes from. The foreign key already cascades, but only the database knows that —
     * Hibernate holds any token it has loaded in the same persistence context, still pointing at a
     * user it is being told to remove, and refuses the flush.
     *
     * Nothing reads this collection. It is lazy and stays unloaded; sessions are issued, rotated
     * and revoked through [net.integr.osmium.account.service.RefreshTokenService].
     */
    @OneToMany(mappedBy = "user", cascade = [CascadeType.ALL], orphanRemoval = true, fetch = FetchType.LAZY)
    var refreshTokens: MutableList<RefreshToken> = mutableListOf(),
) {
    /** Node ids granted by the assigned role. */
    fun nodes(): Set<String> = role?.nodes?.mapTo(mutableSetOf()) { it.id } ?: emptySet()

    /** The replay this account has not been told about yet, if there is one. */
    fun unreadSessionAlert(): Instant? {
        val raised = sessionAlertAt ?: return null
        val seen = sessionAlertSeenAt
        return if (seen == null || seen.isBefore(raised)) raised else null
    }
}

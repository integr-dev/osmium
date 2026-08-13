package net.integr.osmium.account.service

import net.integr.osmium.account.model.RefreshToken
import net.integr.osmium.account.model.User
import net.integr.osmium.account.repository.RefreshTokenRepository
import net.integr.osmium.security.JwtProperties
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.UUID

/** A token as the caller must send it back, alongside when the session it belongs to ends. */
data class IssuedRefreshToken(val value: String, val expiresAt: Instant)

/**
 * Issues, rotates and revokes refresh tokens.
 *
 * **Rotation is one-time.** Every refresh mints a successor and marks its predecessor used, so a
 * token is only ever valid once. That is what turns a long-lived credential into a detectable one:
 * the legitimate holder replaces its cookie and never presents the old value again, so a second
 * presentation means a copy exists somewhere it should not. The response to that is to revoke the
 * whole family — including whatever the thief is holding, and whatever the victim is holding, since
 * there is no way to tell which of the two just called.
 *
 * **The session does not slide.** A successor inherits its predecessor's expiry unchanged, so the
 * session ends a fixed span after the login that began it however much it is used. Operators
 * re-enter a password on that schedule whether or not they were active.
 */
@Service
@Transactional(readOnly = true)
class RefreshTokenService(
    private val refreshTokenRepository: RefreshTokenRepository,
    private val sessionRevocation: SessionRevocation,
    private val properties: JwtProperties,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val random = SecureRandom()

    /** Starts a new session. Its expiry is fixed here and carried by every successor. */
    @Transactional
    fun issue(user: User): IssuedRefreshToken =
        persist(user = user, family = UUID.randomUUID(), expiresAt = Instant.now().plus(properties.refreshTtl))

    /**
     * Exchanges a token for its successor, and returns the account it belongs to.
     *
     * Every failure is the same [BadCredentialsException]: an unknown token, an expired one, a
     * revoked one and a replayed one are all "this is not a session", and telling them apart would
     * only help someone work out which of their guesses was closest.
     */
    @Transactional
    fun rotate(rawToken: String): Pair<User, IssuedRefreshToken> {
        val now = Instant.now()
        val presented = refreshTokenRepository.findByTokenHash(hash(rawToken))
            ?: throw BadCredentialsException(INVALID_SESSION)

        // Presented twice. The holder of a live session never does this, so a copy is in circulation
        // and there is no way to know whether this call is the thief or the victim.
        if (presented.usedAt != null) {
            // Read before revoking: the bulk update clears the persistence context, which detaches
            // `presented` and makes its lazy user unreachable.
            //
            // Committed in its own transaction, because this call ends in an exception and that
            // would otherwise roll the revocation back with it — leaving the replay refused but the
            // family alive, which is the one outcome this branch exists to prevent.
            sessionRevocation.onReuse(family = presented.family, account = presented.user.username, at = now)
            throw BadCredentialsException(INVALID_SESSION)
        }

        if (!presented.isUsable(now)) throw BadCredentialsException(INVALID_SESSION)

        presented.usedAt = now
        // The successor inherits the expiry rather than taking a new one: the session is fixed-length.
        val successor = persist(user = presented.user, family = presented.family, expiresAt = presented.expiresAt)
        return presented.user to successor
    }

    /**
     * Ends the session a token belongs to. Unknown tokens are ignored — a logout that cannot find
     * its session has already achieved what it was asked to do, and reporting the difference would
     * turn this into an oracle for which tokens exist.
     */
    @Transactional
    fun revoke(rawToken: String) {
        val presented = refreshTokenRepository.findByTokenHash(hash(rawToken)) ?: return
        refreshTokenRepository.revokeFamily(presented.family, Instant.now())
    }

    /**
     * Ends every session an account has, and every access token already issued to it.
     *
     * Both halves matter, and only doing the first was the original gap: revoking refresh tokens
     * stops the attacker *renewing*, but the access token they already hold is a stateless JWT that
     * keeps working until it expires. Bumping the account's token version is what actually cuts it
     * off — see [net.integr.osmium.security.DatabaseJwtAuthenticationConverter].
     *
     * Called on a password change, and on an explicit "sign out everywhere". Those are the two
     * things an operator reaches for when they think they have been compromised, and neither should
     * leave anything of the old session working.
     */
    @Transactional
    fun revokeAllFor(user: User) {
        val id = checkNotNull(user.id) { "User has not been persisted yet" }
        // Every access token already issued carries the old version and stops matching here.
        user.tokenVersion += 1
        val revoked = refreshTokenRepository.revokeAllFor(id, Instant.now())
        log.info("Revoked {} session tokens and every access token for {}", revoked, user.username)
    }

    /** The account's live sessions, newest first. Spent links in a rotation chain are not sessions. */
    fun liveSessionsFor(user: User): List<RefreshToken> =
        refreshTokenRepository.findLiveFor(
            userId = checkNotNull(user.id) { "User has not been persisted yet" },
            now = Instant.now(),
        )

    /**
     * Ends one session by id, if it belongs to [user].
     *
     * Ownership is checked here rather than trusted from the caller: an id is a guessable integer,
     * and without this any operator could end anyone's session by counting upwards. A session that
     * is not theirs is reported exactly as one that does not exist.
     */
    @Transactional
    fun revokeSession(user: User, sessionId: Long): Boolean {
        val token = refreshTokenRepository.findById(sessionId).orElse(null) ?: return false
        if (token.user.id != user.id) return false
        refreshTokenRepository.revokeFamily(token.family, Instant.now())
        return true
    }

    /** The hash of a raw token, for callers that need to recognise their own session in a list. */
    fun fingerprint(rawToken: String): String = hash(rawToken)

    /**
     * Drops rows past their expiry. Housekeeping only: an expired token is refused on presentation
     * whether or not this has run.
     */
    @Scheduled(cron = PURGE_CRON)
    @Transactional
    fun purgeExpired() {
        val removed = refreshTokenRepository.deleteExpired(Instant.now())
        if (removed > 0) log.info("Purged {} expired refresh tokens", removed)
    }

    private fun persist(user: User, family: UUID, expiresAt: Instant): IssuedRefreshToken {
        val value = randomToken()
        val token = RefreshToken(
            tokenHash = hash(value),
            user = user,
            family = family,
            issuedAt = Instant.now(),
            expiresAt = expiresAt,
            // Captured per token, not per family, so a session that moves - a laptop carried between
            // networks - shows where it is now rather than where it started.
            clientIp = ClientDetails.ip(),
            userAgent = ClientDetails.userAgent(),
        )
        // Both ends of the association, not just the owning one. Setting only `token.user` leaves
        // the collection on User stale, and deleting that account then fails on a token Hibernate
        // can see but has not been told about. See User.refreshTokens.
        user.refreshTokens.add(token)
        refreshTokenRepository.save(token)
        return IssuedRefreshToken(value = value, expiresAt = expiresAt)
    }

    /** 256 bits from a CSPRNG. Nothing about it is guessable, so nothing about it needs stretching. */
    private fun randomToken(): String {
        val bytes = ByteArray(TOKEN_BYTES).also(random::nextBytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun hash(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private companion object {
        const val TOKEN_BYTES = 32
        const val INVALID_SESSION = "Session expired"

        /** Daily, off the hour the other purges run on. */
        const val PURGE_CRON = "0 20 3 * * *"
    }
}

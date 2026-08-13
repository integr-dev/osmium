package net.integr.osmium.account.service

import net.integr.osmium.account.dto.LoginRequest
import net.integr.osmium.account.dto.LoginResponse
import net.integr.osmium.account.dto.PasswordChangeRequest
import net.integr.osmium.account.dto.SessionResponse
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.account.repository.UserRepository
import net.integr.osmium.security.JwtService
import net.integr.osmium.security.encodeRequired
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import net.integr.osmium.audit.service.AuditService

/**
 * An access token for the response body, and a refresh token for the caller to put in a cookie.
 *
 * Separate on purpose: the access token goes to JavaScript and is held in memory only, the refresh
 * token never reaches JavaScript at all. Cookies are the controller's business, not this service's.
 */
data class IssuedSession(val access: LoginResponse, val refresh: IssuedRefreshToken)

@Service
@Transactional(readOnly = true)
class AuthService(
    private val userRepository: UserRepository,
    private val passwordEncoder: PasswordEncoder,
    private val jwtService: JwtService,
    private val auditService: AuditService,
    private val refreshTokenService: RefreshTokenService,
) {
    /** Writes: starting a session stores a refresh token, so this cannot run read-only. */
    @Transactional
    fun login(request: LoginRequest): IssuedSession {
        val user = userRepository.findByUsername(request.username)
            ?: throw BadCredentialsException(INVALID_CREDENTIALS)

        if (!passwordEncoder.matches(request.password, user.passwordHash)) {
            throw BadCredentialsException(INVALID_CREDENTIALS)
        }

        val access = jwtService.issue(user)
        return IssuedSession(
            access = LoginResponse(token = access.value, expiresAt = access.expiresAt),
            refresh = refreshTokenService.issue(user),
        )
    }

    /**
     * Exchanges a refresh token for a fresh pair.
     *
     * Unauthenticated in the Spring Security sense, deliberately: the cookie *is* the credential.
     * Requiring a live access token as well would defeat the point, since the case this exists for
     * is exactly the one where the access token has expired.
     */
    @Transactional
    fun refresh(rawToken: String): IssuedSession {
        val (user, refreshed) = refreshTokenService.rotate(rawToken)
        val access = jwtService.issue(user)
        return IssuedSession(
            access = LoginResponse(token = access.value, expiresAt = access.expiresAt),
            refresh = refreshed,
        )
    }

    /** Ends the session a token belongs to. An unknown token is a no-op — see [RefreshTokenService]. */
    @Transactional
    fun logout(rawToken: String?) {
        if (!rawToken.isNullOrBlank()) refreshTokenService.revoke(rawToken)
    }

    /**
     * The account's live sessions, with the caller's own marked.
     *
     * Marked by comparing hashes, never by handing the token back: the point of the cookie being
     * `HttpOnly` is that its value never reaches JavaScript, and returning it in a list of sessions
     * would undo that in the name of a checkmark.
     */
    fun sessions(username: String, rawToken: String?): List<SessionResponse> {
        val user = userRepository.findByUsername(username)
            ?: throw NoSuchElementException("No user named '$username'")
        val currentHash = rawToken?.takeIf { it.isNotBlank() }?.let { refreshTokenService.fingerprint(it) }

        return refreshTokenService.liveSessionsFor(user).map { token ->
            SessionResponse(
                id = checkNotNull(token.id),
                startedAt = token.issuedAt,
                expiresAt = token.expiresAt,
                clientIp = token.clientIp,
                userAgent = token.userAgent,
                current = currentHash != null && token.tokenHash == currentHash,
            )
        }
    }

    /** Ends one of the account's own sessions. False when it is not theirs, or does not exist. */
    @Transactional
    fun endSession(username: String, sessionId: Long): Boolean {
        val user = userRepository.findByUsername(username)
            ?: throw NoSuchElementException("No user named '$username'")
        return refreshTokenService.revokeSession(user, sessionId)
    }

    /**
     * Ends every session the account has, including the caller's own, and every access token
     * already issued to it.
     *
     * Deliberately not "all except this one". Somebody reaching for this believes they have been
     * compromised, and the version that spares the current session is the version that spares the
     * attacker's if they are the one clicking it.
     */
    @Transactional
    fun endAllSessions(username: String) {
        val user = userRepository.findByUsername(username)
            ?: throw NoSuchElementException("No user named '$username'")
        refreshTokenService.revokeAllFor(user)
        auditService.record(
            action = AuditAction.SESSION_REVOKED_ALL,
            target = username,
            detail = "Signed out of every session",
        )
    }

    @Transactional
    fun changePassword(username: String, request: PasswordChangeRequest) {
        val user = userRepository.findByUsername(username)
            ?: throw BadCredentialsException(INVALID_CREDENTIALS)

        if (!passwordEncoder.matches(request.currentPassword, user.passwordHash)) {
            throw BadCredentialsException(INVALID_CREDENTIALS)
        }
        require(request.newPassword != request.currentPassword) {
            "New password must differ from the current password"
        }

        // Held before the revocation below, which flushes this change and then clears the
        // persistence context - after that `user` is detached and reading it proves nothing.
        val username = user.username

        user.passwordHash = passwordEncoder.encodeRequired(request.newPassword)
        // Every session this account has, including the one making the call. Changing a password
        // after a scare is meant to lock out whoever had the old one, and leaving their sessions
        // running would be that point entirely missed.
        refreshTokenService.revokeAllFor(user)
        // That it happened, and by whom. Neither password reaches the entry.
        auditService.record(
            action = AuditAction.USER_PASSWORD_CHANGE,
            target = username,
            detail = "Changed their own password",
        )
    }

    private companion object {
        const val INVALID_CREDENTIALS = "Invalid username or password"
    }
}

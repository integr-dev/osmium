package net.integr.osmium.account.service

import net.integr.osmium.account.repository.RefreshTokenRepository
import net.integr.osmium.account.repository.UserRepository
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.service.AuditService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

/**
 * Ends a session that has been replayed, in a transaction of its own.
 *
 * A separate bean rather than a method on [RefreshTokenService], for one reason:
 * `REQUIRES_NEW` is applied by a proxy, and a class calling its own method goes straight to the
 * implementation and never through it. The caller then refuses the request by throwing, which rolls
 * its own transaction back — and with it the revocation, if they shared one. The result would be a
 * replay that is correctly refused while the stolen family stays alive, which is precisely the
 * outcome the detection exists to prevent.
 *
 * That failure is invisible to a test that runs inside a rolled-back transaction of its own, since
 * nothing there ever commits. `SessionRefreshTest` opts out of that for the reuse cases.
 */
@Service
class SessionRevocation(
    private val refreshTokenRepository: RefreshTokenRepository,
    private val userRepository: UserRepository,
    private val auditService: AuditService,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    fun onReuse(family: UUID, account: String, at: Instant) {
        val revoked = refreshTokenRepository.revokeFamily(family, at)
        log.warn("Refresh token reuse for {}; revoked {} tokens in family {}", account, revoked, family)
        auditService.record(
            action = AuditAction.SESSION_REUSE_DETECTED,
            target = account,
            detail = "Replayed refresh token; $revoked session tokens revoked",
        )
        // The trail reaches whoever holds `audit.read`, which is not the person this happened to.
        // They have just been signed out with no explanation, so the notice waits on the account
        // until they come back. Stamped after the bulk update above, which clears the persistence
        // context and would otherwise discard this.
        userRepository.findByUsername(account)?.sessionAlertAt = at
    }
}

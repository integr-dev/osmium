package net.integr.osmium.service

import net.integr.osmium.config.AuditProperties
import net.integr.osmium.dto.AuditEntryResponse
import net.integr.osmium.dto.toResponse
import net.integr.osmium.model.AuditAction
import net.integr.osmium.model.AuditEntry
import net.integr.osmium.repository.AuditEntryRepository
import org.slf4j.LoggerFactory
import org.springframework.data.domain.Limit
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

@Service
@Transactional(readOnly = true)
class AuditService(
    private val auditEntryRepository: AuditEntryRepository,
    private val auditProperties: AuditProperties,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * Records an action by the currently authenticated account.
     *
     * The actor is read from the security context rather than threaded through every command
     * signature. Authorization decisions are passed explicitly elsewhere — `UserService` takes an
     * `actorUsername` — because those *change behaviour* and must be visible at the call site. This
     * only observes, so the implicit read is worth the ten signatures it does not disturb.
     *
     * Called inside the command's own transaction, so an entry exists only if the command it
     * describes actually committed. A command rejected with 503 because no host was connected
     * therefore leaves no trace: nothing happened, so there is nothing to hold anyone to.
     */
    @Transactional
    fun record(action: AuditAction, target: String, detail: String? = null) {
        auditEntryRepository.save(
            AuditEntry(
                at = Instant.now(),
                account = currentAccount(),
                action = action,
                target = target,
                detail = detail?.take(AuditEntry.DETAIL_MAX),
            ),
        )
    }

    fun findRecent(limit: Int): List<AuditEntryResponse> =
        auditEntryRepository.findAllByOrderByAtDescIdDesc(Limit.of(limit)).map { it.toResponse() }

    /**
     * Drops entries past their retention. Runs daily rather than on write: a purge on every command
     * would put a delete in the hot path to save a query that nobody is waiting on.
     */
    @Scheduled(cron = PURGE_CRON)
    @Transactional
    fun purgeExpired() {
        val cutoff = Instant.now().minus(auditProperties.retention)
        val removed = auditEntryRepository.deleteOlderThan(cutoff)
        if (removed > 0) log.info("Purged {} audit entries older than {}", removed, cutoff)
    }

    /**
     * Every recorded action sits behind `@PreAuthorize`, so an unauthenticated caller cannot reach
     * one. The fallback exists so a future internal caller cannot silently write an entry with a
     * blank account.
     */
    private fun currentAccount(): String =
        SecurityContextHolder.getContext().authentication?.name ?: "system"

    private companion object {
        /** 03:30 daily: after midnight rollover, outside any plausible working window. */
        const val PURGE_CRON = "0 30 3 * * *"
    }
}

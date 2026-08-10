package net.integr.osmium.audit.service

import net.integr.osmium.audit.config.AuditProperties
import net.integr.osmium.audit.dto.AuditPageResponse
import net.integr.osmium.audit.dto.toResponse
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.model.AuditEntry
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.web.PageCursor
import org.slf4j.LoggerFactory
import org.springframework.data.domain.Limit
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import net.integr.osmium.account.service.UserService

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

    /**
     * One page of the trail, newest first, optionally narrowed by [query].
     *
     * Searching is done here rather than in the browser. Once the response is a page, a filter that
     * only sees what is loaded is worse than no filter at all: it would search the newest hundred
     * rows of a thirty-day trail and report "nothing matches", which reads as an answer rather than
     * as a limit.
     *
     * [query] matches the account, the target, the detail, or the name of the action. Action names
     * are resolved here because the column stores the enum constant - an operator searching for
     * "chat" means every kind of chat entry, not a substring of some text field.
     */
    fun findPage(limit: Int, cursor: String?, query: String?): AuditPageResponse {
        val (beforeAt, beforeId) = PageCursor.decode(cursor)
        val needle = query?.trim()?.lowercase().orEmpty()

        val rows = auditEntryRepository.page(
            beforeAt = beforeAt,
            beforeId = beforeId,
            // `%` matches every non-null column, so an unfiltered request needs no separate query.
            needle = if (needle.isEmpty()) "%" else "%${escapeLike(needle)}%",
            actions = if (needle.isEmpty()) AuditAction.entries else {
                AuditAction.entries.filter { needle in it.name.lowercase() }
            },
            limit = Limit.of(limit),
        )

        return AuditPageResponse(
            items = rows.map { it.toResponse() },
            // A short page means the trail ran out. A full one may or may not have more, and one
            // wasted request at the end is cheaper than a count on every request.
            nextCursor = rows.lastOrNull()
                ?.takeIf { rows.size == limit }
                ?.let { PageCursor.encode(it.at, checkNotNull(it.id)) },
        )
    }

    /**
     * Neutralises the `like` wildcards so a search for `50%` looks for that text rather than
     * matching everything. Pairs with the `escape '\'` clause on the query.
     */
    private fun escapeLike(needle: String): String =
        needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

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

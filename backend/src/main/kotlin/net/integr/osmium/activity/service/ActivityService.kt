package net.integr.osmium.activity.service

import net.integr.osmium.activity.config.ActivityProperties
import net.integr.osmium.activity.dto.ActivityPageResponse
import net.integr.osmium.activity.dto.toResponse
import net.integr.osmium.activity.model.ActivityEntry
import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import net.integr.osmium.activity.repository.ActivityEntryRepository
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import net.integr.osmium.web.PageCursor
import org.slf4j.LoggerFactory
import org.springframework.data.domain.Limit
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

/**
 * Stores and serves what happened to agents.
 *
 * The counterpart to [net.integr.osmium.audit.service.AuditService]: that one records what people
 * did, this one records what the game did back. Splitting them is what keeps a kick from being
 * buried under a page of routine commands, and lets the two age at different rates.
 */
@Service
@Transactional(readOnly = true)
class ActivityService(
    private val activityEntryRepository: ActivityEntryRepository,
    private val activityProperties: ActivityProperties,
    private val broker: FleetEventBroker,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** Records an incident a host reported and pushes it straight to anyone watching. */
    @Transactional
    fun record(
        agent: Agent,
        scope: ActivityScope,
        severity: ActivitySeverity,
        text: String,
    ): ActivityEntry {
        val saved = activityEntryRepository.save(
            ActivityEntry(
                at = Instant.now(),
                agentId = agent.id,
                agentLabel = agent.label,
                scope = scope,
                severity = severity,
                text = text.take(ActivityEntry.TEXT_MAX),
            ),
        )
        broker.publish(
            FleetEvent(type = FleetEventType.ACTIVITY_ENTRY, data = saved.toResponse(), agentId = agent.id),
        )
        return saved
    }

    /** Every agent's incidents merged when [agentId] is null; one agent's when it is not. */
    fun find(agentId: Long?, limit: Int, cursor: String?): ActivityPageResponse {
        val (beforeAt, beforeId) = PageCursor.decode(cursor)

        val rows = if (agentId == null) {
            activityEntryRepository.page(beforeAt, beforeId, Limit.of(limit))
        } else {
            activityEntryRepository.pageForAgent(beforeAt, beforeId, agentId, Limit.of(limit))
        }

        return ActivityPageResponse(
            items = rows.map { it.toResponse() },
            nextCursor = rows.lastOrNull()
                ?.takeIf { rows.size == limit }
                ?.let { PageCursor.encode(it.at, checkNotNull(it.id)) },
        )
    }

    @Scheduled(cron = PURGE_CRON)
    @Transactional
    fun purgeExpired() {
        val cutoff = Instant.now().minus(activityProperties.retention)
        val removed = activityEntryRepository.deleteOlderThan(cutoff)
        if (removed > 0) log.info("Purged {} activity entries older than {}", removed, cutoff)
    }

    private companion object {
        /** 03:35 daily, between the audit and chat purges so the three do not contend. */
        const val PURGE_CRON = "0 35 3 * * *"
    }
}

package net.integr.osmium.activity.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import java.time.Instant

/**
 * What kind of incident this is. Classified by the host, like [net.integr.osmium.chat.model.ChatScope].
 *
 * Adding a value here requires a manual `ALTER TABLE` against any existing database, for the reason
 * spelled out on [net.integr.osmium.audit.model.AuditEntry.action].
 */
enum class ActivityScope {
    /** The server acted on the agent: kicked, banned, died, warned. */
    SYSTEM,

    /** The session itself changed: connected, disconnected, setup failed, relink needed. */
    LIFECYCLE,
}

/** How much attention the line deserves. Decided by the host, which knows what it observed. */
enum class ActivitySeverity {
    INFO,
    WARNING,
    ERROR,
}

/**
 * Something that happened *to* an agent, as opposed to something an operator did or anything said.
 *
 * Kept out of chat deliberately: an agent silently kicked at 03:00 is exactly the failure the
 * dashboard exists to surface, and a line scrolling past a chat panel nobody has open does not
 * surface it.
 *
 * Kept for ten days. Diagnostics go stale - a crash loop is investigated within days or not at all -
 * so this sits between the 30-day operator audit and the 3-day chat window.
 *
 * The agent is referenced by id and label as plain columns, not a relation, matching
 * [net.integr.osmium.audit.model.AuditEntry]: an incident has to stay readable once its subject is
 * gone, and "Mason_04 was banned" is precisely the line you want after Mason_04 has been deleted.
 */
@Entity
@Table(
    name = "activity_entries",
    indexes = [
        // The fleet-wide feed sorts on these alone; the per-agent feed filters first, so it gets an
        // index with the sort columns trailing the filter.
        Index(name = "idx_activity_entries_at_id", columnList = "at, id"),
        Index(name = "idx_activity_entries_agent", columnList = "agent_id, at, id"),
    ],
)
class ActivityEntry(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    /** When the backend received it. Host clocks are not synchronised; see `ChatMessage.at`. */
    @Column(name = "at", nullable = false)
    var at: Instant = Instant.now(),

    @Column(name = "agent_id")
    var agentId: Long? = null,

    @Column(name = "agent_label", nullable = false, length = 64)
    var agentLabel: String = "",

    @Enumerated(EnumType.STRING)
    @Column(name = "scope", nullable = false, length = 16)
    var scope: ActivityScope = ActivityScope.LIFECYCLE,

    @Enumerated(EnumType.STRING)
    @Column(name = "severity", nullable = false, length = 16)
    var severity: ActivitySeverity = ActivitySeverity.INFO,

    /** What happened, in the host's words. Rendered as-is, so it has to read as a sentence. */
    @Column(name = "body", nullable = false, length = TEXT_MAX)
    var text: String = "",
) {
    companion object {
        const val TEXT_MAX = 512
    }
}

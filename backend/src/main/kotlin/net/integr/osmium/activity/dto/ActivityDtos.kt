package net.integr.osmium.activity.dto

import io.swagger.v3.oas.annotations.media.Schema
import net.integr.osmium.activity.model.ActivityEntry
import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import java.time.Instant

@Schema(description = "Something that happened to an agent: kicked, died, connected, relink needed.")
data class ActivityEntryResponse(
    val id: Long,
    @param:Schema(description = "When Osmium received it, not when the host observed it.")
    val at: Instant,
    @param:Schema(description = "The agent it happened to. Null once that agent has been deleted.")
    val agentId: Long?,
    @param:Schema(description = "The agent's label at the time, so the line still reads after a deletion.")
    val agentLabel: String,
    val scope: ActivityScope,
    val severity: ActivitySeverity,
    @param:Schema(example = "Kicked: flying is not enabled on this server")
    val text: String,
)

@Schema(description = "One page of activity, newest first.")
data class ActivityPageResponse(
    val items: List<ActivityEntryResponse>,
    @param:Schema(
        description = "Pass back as `cursor` for the next, older page. Null when the feed ends.",
        example = "2026-08-10T09:14:22.481Z|417",
    )
    val nextCursor: String?,
)

fun ActivityEntry.toResponse(): ActivityEntryResponse = ActivityEntryResponse(
    id = checkNotNull(id) { "Activity entry has not been persisted yet" },
    at = at,
    agentId = agentId,
    agentLabel = agentLabel,
    scope = scope,
    severity = severity,
    text = text,
)

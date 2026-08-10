package net.integr.osmium.audit.dto

import io.swagger.v3.oas.annotations.media.Schema
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.model.AuditEntry
import java.time.Instant

@Schema(description = "One operator action: who did what, to which agent or host.")
data class AuditEntryResponse(
    val id: Long,
    val at: Instant,
    @param:Schema(description = "Username of the acting account at the time.", example = "admin")
    val account: String,
    val action: AuditAction,
    @param:Schema(description = "Name of the agent or host acted on.", example = "Mason_02")
    val target: String,
    @param:Schema(description = "Outbound message text for AGENT_CHAT; a short outcome otherwise.")
    val detail: String?,
)

@Schema(description = "One page of the trail, newest first.")
data class AuditPageResponse(
    val items: List<AuditEntryResponse>,
    @param:Schema(
        description = "Pass back as `cursor` to fetch the next, older page. Null when the trail ends.",
        example = "2026-08-10T09:14:22.481Z|417",
    )
    val nextCursor: String?,
)

fun AuditEntry.toResponse(): AuditEntryResponse = AuditEntryResponse(
    id = checkNotNull(id) { "Audit entry has not been persisted yet" },
    at = at,
    account = account,
    action = action,
    target = target,
    detail = detail,
)

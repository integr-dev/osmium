package net.integr.osmium.audit.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.audit.dto.AuditPageResponse
import net.integr.osmium.audit.service.AuditService
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import net.integr.osmium.agent.model.Agent

@RestController
@RequestMapping("/api/audit")
@Tag(name = "Audit", description = "What operators did. Agent-side events are the activity feed, not this.")
class AuditController(private val auditService: AuditService) {

    @GetMapping
    @PreAuthorize("hasAuthority('audit.read')")
    @Operation(
        summary = "One page of operator actions, newest first.",
        description = """
            Pages by cursor, not by offset: the trail grows while it is being read, so an offset
            would repeat or skip entries between requests. Send `nextCursor` from the previous
            response to continue; a null `nextCursor` means the trail ended.

            Entries are kept for 30 days by default and purged daily.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "A page of entries, oldest continuing at `nextCursor`."),
        ApiResponse(responseCode = "400", description = "Malformed `cursor`."),
        ApiResponse(responseCode = "403", description = "Missing node `audit.read`."),
    )
    fun list(
        @Parameter(description = "How many entries to return. Clamped to 1..500.")
        @RequestParam(defaultValue = "100") limit: Int,
        @Parameter(description = "`nextCursor` from the previous page. Omit for the newest entries.")
        @RequestParam(required = false) cursor: String?,
        @Parameter(description = "Narrows to entries whose account, target, detail or action matches.")
        @RequestParam(required = false) query: String?,
    ): AuditPageResponse =
        auditService.findPage(limit.coerceIn(MIN_LIMIT, MAX_LIMIT), cursor, query)

    private companion object {
        const val MIN_LIMIT = 1
        const val MAX_LIMIT = 500
    }
}

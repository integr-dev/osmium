package net.integr.osmium.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.dto.AuditEntryResponse
import net.integr.osmium.service.AuditService
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/audit")
@Tag(name = "Audit", description = "What operators did. Agent-side events are the activity feed, not this.")
class AuditController(private val auditService: AuditService) {

    @GetMapping
    @PreAuthorize("hasAuthority('audit.read')")
    @Operation(
        summary = "List recent operator actions, newest first.",
        description = "Entries are kept for 30 days by default and purged daily.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Recent entries."),
        ApiResponse(responseCode = "403", description = "Missing node `audit.read`."),
    )
    fun list(
        @Parameter(description = "How many entries to return, newest first. Clamped to 1..1000.")
        @RequestParam(defaultValue = "200") limit: Int,
    ): List<AuditEntryResponse> = auditService.findRecent(limit.coerceIn(MIN_LIMIT, MAX_LIMIT))

    private companion object {
        const val MIN_LIMIT = 1
        const val MAX_LIMIT = 1000
    }
}

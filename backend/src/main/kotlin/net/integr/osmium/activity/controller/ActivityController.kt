package net.integr.osmium.activity.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.activity.dto.ActivityPageResponse
import net.integr.osmium.activity.service.ActivityService
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/activity")
@Tag(
    name = "Activity",
    description = "What happened to agents. What operators did is the audit log; what was said is chat.",
)
class ActivityController(private val activityService: ActivityService) {

    @GetMapping
    @PreAuthorize("hasAuthority('fleet.read')")
    @Operation(
        summary = "One page of agent incidents, newest first.",
        description = """
            Every agent's incidents merged, or one agent's when `agentId` is given.

            Pages by cursor, not by offset: incidents arrive while the feed is being read. Send
            `nextCursor` from the previous response to continue. Kept for 10 days.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "A page of activity."),
        ApiResponse(responseCode = "400", description = "Malformed `cursor`."),
        ApiResponse(responseCode = "403", description = "Missing node `fleet.read`."),
    )
    fun list(
        @Parameter(description = "Narrow to one agent. Omit for the whole fleet.")
        @RequestParam(required = false) agentId: Long?,
        @Parameter(description = "How many entries to return. Clamped to 1..500.")
        @RequestParam(defaultValue = "100") limit: Int,
        @Parameter(description = "`nextCursor` from the previous page. Omit for the newest entries.")
        @RequestParam(required = false) cursor: String?,
    ): ActivityPageResponse =
        activityService.find(agentId, limit.coerceIn(MIN_LIMIT, MAX_LIMIT), cursor)

    private companion object {
        const val MIN_LIMIT = 1
        const val MAX_LIMIT = 500
    }
}

package net.integr.osmium.dashboard.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.dashboard.dto.DashboardSampleResponse
import net.integr.osmium.dashboard.service.DashboardHistory
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/dashboard")
@Tag(name = "Dashboard", description = "The fleet over time.")
class DashboardController(private val history: DashboardHistory) {

    @GetMapping("/history")
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(
        summary = "The last six hours, a point every ten seconds.",
        description = "Oldest first. Kept in memory, so it starts empty when the backend starts. " +
            "Each new point is also pushed on the live stream as `dashboard-sample`.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Every point held."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
    )
    fun history(): List<DashboardSampleResponse> = history.all()
}

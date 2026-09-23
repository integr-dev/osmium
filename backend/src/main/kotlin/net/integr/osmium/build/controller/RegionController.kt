package net.integr.osmium.build.controller

import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import jakarta.validation.Valid
import net.integr.osmium.build.dto.CreateRegionRequest
import net.integr.osmium.build.dto.RegionResponse
import net.integr.osmium.build.dto.UpdateRegionRequest
import net.integr.osmium.build.service.RegionService
import org.springframework.http.HttpStatus
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * Region plans: a box of world to be dug out or charted.
 *
 * **Gated on the agent nodes, not the schematic ones** - which is where this parts company with
 * [BuildController]. A build plan is a design: it says where a *file* goes, and reading or editing
 * one tells you nothing about the fleet. A region has no file. It is a piece of the world somebody
 * intends the fleet to work, so it belongs with the things that say what the fleet is doing.
 *
 * Writing is `agent.run`, the node that dispatches: a region is written down in order to be worked,
 * and the same person decides both.
 */
@RestController
@RequestMapping("/api/regions")
class RegionController(private val service: RegionService) {

    @GetMapping
    @PreAuthorize("hasAuthority('agent.read')")
    fun list(): List<RegionResponse> = service.findAll()

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('agent.read')")
    fun find(@PathVariable id: Long): RegionResponse = service.find(id)

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('agent.run')")
    @ApiResponses(
        ApiResponse(responseCode = "201", description = "Created."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.run`."),
        ApiResponse(
            responseCode = "409",
            description = "The name is taken, or the region is empty or past the size limit.",
        ),
    )
    fun create(@Valid @RequestBody request: CreateRegionRequest): RegionResponse =
        service.create(request)

    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('agent.run')")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Edited."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.run`."),
        ApiResponse(
            responseCode = "409",
            description = "The name is taken, one corner was given without the other, or the " +
                "region is empty or past the size limit.",
        ),
    )
    fun update(
        @PathVariable id: Long,
        @Valid @RequestBody request: UpdateRegionRequest,
    ): RegionResponse = service.update(id, request)

    /**
     * Removes a plan.
     *
     * `agent.delete`, alongside deleting a job: this takes a row that jobs hang off, and the trail
     * keeps what was done either way.
     */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('agent.delete')")
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Removed."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.delete`."),
        ApiResponse(responseCode = "409", description = "A job of it is running; pause that first."),
    )
    fun delete(@PathVariable id: Long) = service.delete(id)
}

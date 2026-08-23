package net.integr.osmium.build.controller

import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import jakarta.validation.Valid
import net.integr.osmium.build.dto.AssignSegmentRequest
import net.integr.osmium.build.dto.BuildJobResponse
import net.integr.osmium.build.dto.StartJobRequest
import net.integr.osmium.build.service.BuildJobService
import org.springframework.http.HttpStatus
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * Build jobs: a plan being carried out by a set of agents.
 *
 * **Gated on `agent.run`, not on the schematic nodes.** Editing a plan is a decision about a
 * drawing and drives nothing; starting a job puts agents to work, which is the same authority as
 * connecting one. Someone who may design a build and someone who may dispatch the fleet are
 * deliberately different people.
 *
 * Reading is `agent.read` for the matching reason: a job's interesting content is which agents are
 * on which piece and how far each has got.
 */
@RestController
@RequestMapping("/api")
class BuildJobController(private val service: BuildJobService) {

    @GetMapping("/jobs")
    @PreAuthorize("hasAuthority('agent.read')")
    fun list(@RequestParam(required = false) buildId: Long?): List<BuildJobResponse> =
        if (buildId == null) service.findAll() else service.findAllForBuild(buildId)

    @GetMapping("/jobs/{id}")
    @PreAuthorize("hasAuthority('agent.read')")
    fun find(@PathVariable id: Long): BuildJobResponse = service.find(id)

    /**
     * Freezes the plan and hands its pieces out.
     *
     * The number of parts is the number of agents, and the server is derived from them: both would
     * otherwise be a second place to say something the request already says.
     */
    @PostMapping("/builds/{buildId}/jobs")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('agent.run')")
    @ApiResponses(
        ApiResponse(responseCode = "201", description = "Started."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.run`."),
        ApiResponse(
            responseCode = "409",
            description = "The plan is unplaced, its schematic is not read, the agents are not " +
                "all online on one server, or this build is already running.",
        ),
    )
    fun start(
        @PathVariable buildId: Long,
        @Valid @RequestBody request: StartJobRequest,
    ): BuildJobResponse = service.start(buildId, request)

    /**
     * Stops a job, keeping its segments, its crew and its counts. [resume] picks it up again.
     *
     * Pause rather than cancel: cancelling stopped a job and then left nothing to do with it but
     * delete it, so an operator had to perform two acts to express one.
     */
    @PostMapping("/jobs/{id}/pause")
    @PreAuthorize("hasAuthority('agent.run')")
    fun pause(@PathVariable id: Long): BuildJobResponse = service.pause(id)

    @PostMapping("/jobs/{id}/resume")
    @PreAuthorize("hasAuthority('agent.run')")
    fun resume(@PathVariable id: Long): BuildJobResponse = service.resume(id)

    /**
     * Clears a finished job out of the list.
     *
     * `agent.delete`, alongside removing an agent or a host. Every other act on a job is
     * recoverable — a paused one resumes — and this one takes the segments and their counts with it,
     * so it sits with the tier that already carries the fleet's irreversible operations.
     *
     * It is also what frees the crew of a job nobody intends to finish, since a paused job goes on
     * holding its agents.
     */
    @DeleteMapping("/jobs/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('agent.delete')")
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Removed."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.delete`."),
        ApiResponse(responseCode = "409", description = "The job is still building; pause it first."),
    )
    fun delete(@PathVariable id: Long) = service.delete(id)

    @PostMapping("/jobs/{jobId}/segments/{segmentId}/assignment")
    @PreAuthorize("hasAuthority('agent.run')")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Assigned."),
        ApiResponse(
            responseCode = "409",
            description = "The job is finished, the segment is built, or the agent is offline, on " +
                "another server, or already holding a segment.",
        ),
    )
    fun assign(
        @PathVariable jobId: Long,
        @PathVariable segmentId: Long,
        @Valid @RequestBody request: AssignSegmentRequest,
    ): BuildJobResponse = service.assign(jobId, segmentId, request)

    /**
     * Takes a segment back. It returns to the pool rather than being marked failed - an operator
     * moving work is not the same event as a host that could not do it.
     */
    @DeleteMapping("/jobs/{jobId}/segments/{segmentId}/assignment")
    @PreAuthorize("hasAuthority('agent.run')")
    fun release(@PathVariable jobId: Long, @PathVariable segmentId: Long): BuildJobResponse =
        service.release(jobId, segmentId)
}

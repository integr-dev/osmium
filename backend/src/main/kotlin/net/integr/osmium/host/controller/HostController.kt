package net.integr.osmium.host.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import net.integr.osmium.host.dto.CreateHostRequest
import net.integr.osmium.host.dto.HostEnrolledResponse
import net.integr.osmium.host.dto.HostResponse
import net.integr.osmium.host.dto.UpdateHostRequest
import net.integr.osmium.host.service.HostService
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
import net.integr.osmium.host.model.Host

@RestController
@RequestMapping("/api/hosts")
@Tag(name = "Hosts", description = "Machines that run the agents. They hold the credentials; Osmium does not.")
class HostController(private val hostService: HostService) {

    @GetMapping
    @PreAuthorize("hasAuthority('host.read')")
    @Operation(summary = "List hosts.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "All hosts."),
        ApiResponse(responseCode = "403", description = "Missing node `host.read`."),
    )
    fun list(): List<HostResponse> = hostService.findAll()

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('host.write')")
    @Operation(
        summary = "Enrol a host.",
        description = "Returns the enrolment token once. Only its hash is stored, so it cannot be " +
            "retrieved later - a lost token is replaced by re-enrolling. No address is taken: the " +
            "host connects to Osmium, so its location is observed on connect.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "201", description = "Host enrolled; token returned once."),
        ApiResponse(responseCode = "400", description = "Blank or over-long name."),
        ApiResponse(responseCode = "403", description = "Missing node `host.write`."),
        ApiResponse(responseCode = "409", description = "Name already enrolled."),
    )
    fun enrol(@Valid @RequestBody request: CreateHostRequest): HostEnrolledResponse =
        hostService.enrol(request)

    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('host.write')")
    @Operation(
        summary = "Rename a host.",
        description = "Only the name is editable; address, version and reachability are observed " +
            "from the connection rather than configured.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Updated host."),
        ApiResponse(responseCode = "400", description = "Blank or over-long name."),
        ApiResponse(responseCode = "403", description = "Missing node `host.write`."),
        ApiResponse(responseCode = "404", description = "No such host."),
        ApiResponse(responseCode = "409", description = "Name already enrolled."),
    )
    fun rename(
        @PathVariable id: Long,
        @Valid @RequestBody request: UpdateHostRequest,
    ): HostResponse = hostService.rename(id, request)

    @PostMapping("/{id}/rotate-token")
    @PreAuthorize("hasAuthority('host.token')")
    @Operation(
        summary = "Issue a new enrolment token.",
        description = "Invalidates the previous token and closes the host's current connection, so " +
            "it must reconnect with the new one. Use this instead of deleting a host when a token " +
            "leaks - the host keeps its agents.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "New token, returned once."),
        ApiResponse(responseCode = "403", description = "Missing node `host.token`."),
        ApiResponse(responseCode = "404", description = "No such host."),
    )
    fun rotateToken(@PathVariable id: Long): HostEnrolledResponse = hostService.rotateToken(id)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('host.delete')")
    @Operation(
        summary = "Remove a host.",
        description = "Cascades to its agents, which cannot run without it. Invalidates the token.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Host and its agents removed."),
        ApiResponse(responseCode = "403", description = "Missing node `host.delete`."),
        ApiResponse(responseCode = "404", description = "No such host."),
    )
    fun delete(@PathVariable id: Long) = hostService.delete(id)
}

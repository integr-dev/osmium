package net.integr.osmium.schematic.controller

import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import net.integr.osmium.schematic.dto.CreateSchematicRequest
import net.integr.osmium.schematic.dto.MaterialResponse
import net.integr.osmium.schematic.dto.RenameSchematicRequest
import net.integr.osmium.schematic.SplitMode
import net.integr.osmium.schematic.dto.SchematicResponse
import net.integr.osmium.schematic.dto.SplitResponse
import net.integr.osmium.schematic.service.SchematicService
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * The schematic library.
 *
 * Upload is three calls rather than one multipart form, and that is the whole design: declaring the
 * size first lets a file too large for this deployment be refused in one small request, and sending
 * the bytes at an explicit offset lets a transfer that died at 90% continue instead of starting
 * again. A multipart upload of several gigabytes over a domestic connection has one failure mode,
 * and it is losing all of it.
 */
@RestController
@RequestMapping("/api/schematics")
class SchematicController(private val service: SchematicService) {

    @GetMapping
    @PreAuthorize("hasAuthority('schematic.read')")
    fun list(): List<SchematicResponse> = service.findAll()

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('schematic.read')")
    fun find(@PathVariable id: Long): SchematicResponse = service.find(id)

    @GetMapping("/{id}/materials")
    @PreAuthorize("hasAuthority('schematic.read')")
    fun materials(@PathVariable id: Long): List<MaterialResponse> = service.materials(id)

    /**
     * How the build divides between a number of agents.
     *
     * A GET because it is a question rather than an act: the answer is a pure function of the
     * schematic and the two arguments, nothing is stored, and asking again gives the same segments.
     */
    @GetMapping("/{id}/split")
    @PreAuthorize("hasAuthority('schematic.read')")
    fun split(
        @PathVariable id: Long,
        @RequestParam mode: SplitMode,
        @RequestParam parts: Int,
    ): SplitResponse = service.split(id, mode, parts)

    /** Reserves the schematic and its file. No bytes yet — see [upload]. */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('schematic.write')")
    fun create(@Valid @RequestBody request: CreateSchematicRequest): SchematicResponse =
        service.create(request)

    /**
     * Sends one chunk, at an explicit offset.
     *
     * The offset is required rather than implied, so that a client which is unsure what arrived
     * cannot append to the wrong place. A mismatch is a 409 carrying the real offset, which makes a
     * resume one round trip: ask, get told, continue.
     *
     * The body is the raw bytes. Not multipart — a multipart parser wants the part in memory or in
     * a temporary file, and at these sizes that is a second copy of a file already too big for one.
     */
    @PutMapping("/{id}/content", consumes = [MediaType.APPLICATION_OCTET_STREAM_VALUE])
    @PreAuthorize("hasAuthority('schematic.write')")
    fun upload(
        @PathVariable id: Long,
        @RequestParam offset: Long,
        request: HttpServletRequest,
    ): SchematicResponse = service.append(id, offset, request.inputStream)

    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('schematic.write')")
    fun rename(
        @PathVariable id: Long,
        @Valid @RequestBody request: RenameSchematicRequest,
    ): SchematicResponse = service.rename(id, request.name)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('schematic.delete')")
    fun delete(@PathVariable id: Long) = service.delete(id)
}

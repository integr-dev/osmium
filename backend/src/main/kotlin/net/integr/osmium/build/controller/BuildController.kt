package net.integr.osmium.build.controller

import jakarta.validation.Valid
import net.integr.osmium.build.dto.BuildResponse
import net.integr.osmium.build.dto.CreateBuildRequest
import net.integr.osmium.build.dto.UpdateBuildRequest
import net.integr.osmium.build.service.BuildService
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
 * Build plans: a schematic, where it stands, and what it is built out of.
 *
 * **Gated on the schematic nodes rather than a pair of its own.** A plan is a decision *about* a
 * schematic — the same act as choosing what to build — and it drives no agent by existing. The
 * moment that changes is dispatch, which is `agent.run`, and that does not exist yet.
 *
 * Nothing derived is served from here. The offset a placement implies, the material totals once
 * substitutions are applied, the world coordinates of a segment: all of it is arithmetic over this
 * plan and the schematic index, computed where it is read.
 */
@RestController
@RequestMapping("/api/builds")
class BuildController(private val service: BuildService) {

    @GetMapping
    @PreAuthorize("hasAuthority('schematic.read')")
    fun list(): List<BuildResponse> = service.findAll()

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('schematic.read')")
    fun find(@PathVariable id: Long): BuildResponse = service.find(id)

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('schematic.write')")
    fun create(@Valid @RequestBody request: CreateBuildRequest): BuildResponse = service.create(request)

    /**
     * `PATCH`, because every field is optional and omitting one leaves it alone. Placement is the
     * one thing that cannot be cleared by omission — JSON cannot tell absent from null — so it
     * carries an explicit `unplace`.
     */
    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('schematic.write')")
    fun update(@PathVariable id: Long, @Valid @RequestBody request: UpdateBuildRequest): BuildResponse =
        service.update(id, request)

    /**
     * `schematic.delete`, alongside removing the schematic itself.
     *
     * A plan costs nothing to make and is the record of a decision somebody took about where a
     * build goes. Deleting it is not the reverse of creating it — the coordinates and the rule set
     * are gone with it — so it sits with the tier holding the fleet's other irreversible operations.
     */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('schematic.delete')")
    fun delete(@PathVariable id: Long) = service.delete(id)
}

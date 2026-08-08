package net.integr.osmium.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.dto.RoleResponse
import net.integr.osmium.service.RoleService
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/roles")
@Tag(name = "Roles", description = "The seeded roles and the permission nodes they grant.")
class RoleController(private val roleService: RoleService) {

    @GetMapping
    @PreAuthorize("hasAuthority('role.read')")
    @Operation(summary = "List every role with its permission nodes.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "All roles."),
        ApiResponse(responseCode = "403", description = "Missing node `role.read`."),
    )
    fun list(): List<RoleResponse> = roleService.findAll()
}

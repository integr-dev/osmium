package net.integr.osmium.account.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import net.integr.osmium.account.dto.CreateUserRequest
import net.integr.osmium.account.dto.UpdateRoleRequest
import net.integr.osmium.account.dto.UpdateSelfRequest
import net.integr.osmium.account.dto.UpdateUserRequest
import net.integr.osmium.account.dto.UserResponse
import net.integr.osmium.account.service.UserService
import org.springframework.http.HttpStatus
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/users")
@Tag(name = "Users", description = "Administrator-managed accounts. There is no self-registration.")
class UserController(private val userService: UserService) {

    @GetMapping
    @PreAuthorize("hasAuthority('user.read')")
    @Operation(summary = "List every account.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "All accounts."),
        ApiResponse(responseCode = "403", description = "Missing node `user.read`."),
    )
    fun list(): List<UserResponse> = userService.findAll()

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('user.create')")
    @Operation(summary = "Create an account with a chosen username and password.")
    @ApiResponses(
        ApiResponse(responseCode = "201", description = "Account created."),
        ApiResponse(responseCode = "400", description = "Blank username, short password or unknown role."),
        ApiResponse(responseCode = "403", description = "Missing node `user.create`."),
        ApiResponse(responseCode = "409", description = "Username already taken."),
    )
    fun create(@Valid @RequestBody request: CreateUserRequest): UserResponse = userService.create(request)

    @PatchMapping("/me")
    @PreAuthorize("hasAuthority('user.edit.self')")
    @Operation(
        summary = "Edit the authenticated account.",
        description = "Renaming yourself invalidates tokens issued under the old username, since the " +
            "token subject no longer resolves. Log in again afterwards.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Updated account."),
        ApiResponse(responseCode = "400", description = "Blank or over-long username."),
        ApiResponse(responseCode = "403", description = "Missing node `user.edit.self`."),
        ApiResponse(responseCode = "409", description = "Username already taken."),
    )
    fun updateSelf(
        @Valid @RequestBody request: UpdateSelfRequest,
        authentication: Authentication,
    ): UserResponse = userService.updateSelf(actorUsername = authentication.name, request = request)

    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('user.edit')")
    @Operation(
        summary = "Edit another account.",
        description = "Supplying a password resets it without knowing the current one. An account " +
            "cannot target itself here - use PATCH /api/users/me and POST /api/auth/password - so " +
            "changing your own password always requires the current one.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Updated account."),
        ApiResponse(responseCode = "400", description = "Blank username or password outside the allowed length."),
        ApiResponse(responseCode = "403", description = "Missing node `user.edit`."),
        ApiResponse(responseCode = "404", description = "No such account."),
        ApiResponse(responseCode = "409", description = "Username already taken, or the account is the caller's own."),
    )
    fun update(
        @PathVariable id: Long,
        @Valid @RequestBody request: UpdateUserRequest,
        authentication: Authentication,
    ): UserResponse = userService.update(
        id = id,
        request = request,
        actorUsername = authentication.name,
    )

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('user.delete')")
    @Operation(
        summary = "Delete an account.",
        description = "An account cannot delete itself, so an administrator cannot lock themselves out.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Account deleted."),
        ApiResponse(responseCode = "403", description = "Missing node `user.delete`."),
        ApiResponse(responseCode = "404", description = "No such account."),
        ApiResponse(responseCode = "409", description = "The account is the caller's own."),
    )
    fun delete(
        @PathVariable id: Long,
        authentication: Authentication,
    ) = userService.delete(id = id, actorUsername = authentication.name)

    @PutMapping("/{id}/role")
    @PreAuthorize("hasAuthority('user.role.write')")
    @Operation(
        summary = "Replace the role of an account.",
        description = "Roles are nested seniority levels, so an account holds exactly one or none. " +
            "An account cannot change its own role, so an administrator cannot demote themselves.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Updated account."),
        ApiResponse(responseCode = "400", description = "Unknown role name."),
        ApiResponse(responseCode = "403", description = "Missing node `user.role.write`."),
        ApiResponse(responseCode = "404", description = "No such account."),
        ApiResponse(responseCode = "409", description = "The account is the caller's own."),
    )
    fun replaceRole(
        @PathVariable id: Long,
        @Valid @RequestBody request: UpdateRoleRequest,
        authentication: Authentication,
    ): UserResponse = userService.replaceRole(
        id = id,
        request = request,
        actorUsername = authentication.name,
    )
}

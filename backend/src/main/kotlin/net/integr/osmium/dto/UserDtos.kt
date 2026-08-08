package net.integr.osmium.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size

@Schema(description = "A user account. Passwords are never returned.")
data class UserResponse(
    val id: Long,
    val username: String,
    @field:Schema(description = "Assigned role names.", example = "[\"administrator\"]")
    val roles: List<String>,
    @field:Schema(description = "Effective permission nodes, flattened across all assigned roles.")
    val nodes: List<String>,
)

@Schema(description = "Creates an account with an administrator-chosen username and password.")
data class CreateUserRequest(
    @field:NotBlank
    @field:Size(max = USERNAME_MAX_LENGTH)
    val username: String,

    @field:Size(min = PASSWORD_MIN_LENGTH, max = PASSWORD_MAX_LENGTH)
    val password: String,

    @field:Schema(description = "Role names to assign. Every name must already exist.")
    val roles: Set<String> = emptySet(),
)

@Schema(description = "Edits the authenticated account. Roles are deliberately not editable here.")
data class UpdateSelfRequest(
    @field:NotBlank
    @field:Size(max = USERNAME_MAX_LENGTH)
    val username: String,
)

@Schema(description = "Edits any account. Only an administrator can set a password without knowing the old one.")
data class UpdateUserRequest(
    @field:NotBlank
    @field:Size(max = USERNAME_MAX_LENGTH)
    val username: String,

    @field:Size(min = PASSWORD_MIN_LENGTH, max = PASSWORD_MAX_LENGTH)
    @field:Schema(description = "Omit to leave the password untouched.")
    val password: String? = null,
)

@Schema(description = "Replaces the full role set of an account.")
data class UpdateRolesRequest(
    val roles: Set<String>,
)

/** Matches the `users.username` column length. */
const val USERNAME_MAX_LENGTH = 64

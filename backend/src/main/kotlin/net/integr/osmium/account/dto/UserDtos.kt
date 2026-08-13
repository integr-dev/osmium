package net.integr.osmium.account.dto

import io.swagger.v3.oas.annotations.media.Schema
import net.integr.osmium.account.model.User
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import net.integr.osmium.account.model.Role
import java.time.Instant

@Schema(description = "A user account. Passwords are never returned.")
data class UserResponse(
    val id: Long,
    val username: String,
    @field:Schema(description = "Assigned role, or null when the account has none.", example = "administrator")
    val role: String?,
    @field:Schema(description = "Permission nodes granted by the assigned role.")
    val nodes: List<String>,

    /**
     * On the shared response rather than only on `/api/auth/me`: it costs nothing there, the
     * alternative is a second shape for one field, and it tells an administrator reading the account
     * list nothing the audit trail would not.
     */
    @field:Schema(
        description = "When a refresh token for this account was replayed, if the operator has not " +
            "been shown it yet. Null the rest of the time, which is nearly always.",
    )
    val sessionAlertAt: Instant?,
)

@Schema(description = "Creates an account with an administrator-chosen username and password.")
data class CreateUserRequest(
    @field:NotBlank
    @field:Size(max = USERNAME_MAX_LENGTH)
    val username: String,

    @field:Size(min = PASSWORD_MIN_LENGTH, max = PASSWORD_MAX_LENGTH)
    val password: String,

    @field:Schema(description = "Role name to assign. Must already exist. Omit for no permissions.")
    val role: String? = null,
)

@Schema(description = "Edits the authenticated account. The role is deliberately not editable here.")
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

@Schema(description = "Replaces the role of an account. Null clears it, leaving no permissions.")
data class UpdateRoleRequest(
    val role: String?,
)

fun User.toResponse(): UserResponse = UserResponse(
    id = checkNotNull(id) { "User has not been persisted yet" },
    username = username,
    role = role?.name,
    nodes = nodes().sorted(),
    sessionAlertAt = unreadSessionAlert(),
)

/** Matches the `users.username` column length. */
const val USERNAME_MAX_LENGTH = 64

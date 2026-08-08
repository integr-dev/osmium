package net.integr.osmium.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import java.time.Instant

@Schema(description = "Credentials for a login attempt.")
data class LoginRequest(
    @field:NotBlank
    @field:Schema(example = "admin")
    val username: String,

    @field:NotBlank
    @field:Schema(example = "admin")
    val password: String,
)

@Schema(description = "A freshly issued access token.")
data class LoginResponse(
    @field:Schema(description = "Signed JWT to send as `Authorization: Bearer <token>`.")
    val token: String,
    val expiresAt: Instant,
)

@Schema(description = "Rotates the password of the authenticated account.")
data class PasswordChangeRequest(
    @field:NotBlank
    val currentPassword: String,

    @field:Size(min = PASSWORD_MIN_LENGTH, max = PASSWORD_MAX_LENGTH)
    val newPassword: String,
)

@Schema(description = "Error payload returned for every handled failure.")
data class ApiError(val message: String)

const val PASSWORD_MIN_LENGTH = 4

/** BCrypt silently ignores input past 72 bytes, so reject it rather than truncate it. */
const val PASSWORD_MAX_LENGTH = 72

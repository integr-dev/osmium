package net.integr.osmium.account.dto

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

@Schema(
    description = "One live session. Only the tip of each rotation chain is listed — a spent token " +
        "is a step in a chain, not something an operator would recognise.",
)
data class SessionResponse(
    val id: Long,
    @field:Schema(description = "When this link in the chain was issued.")
    val startedAt: Instant,
    @field:Schema(description = "When the session ends regardless of use. Refreshing does not move it.")
    val expiresAt: Instant,
    @field:Schema(
        description = "Where it was last seen from, or null when the request carried nothing usable. " +
            "Only meaningful where the deployment's proxy headers are trusted.",
        example = "203.0.113.7",
    )
    val clientIp: String?,
    @field:Schema(description = "Self-declared by the browser, and not evidence of anything.")
    val userAgent: String?,
    @field:Schema(description = "True for the session making this request - the one not to end by accident.")
    val current: Boolean,
)

@Schema(description = "Error payload returned for every handled failure.")
data class ApiError(val message: String)

const val PASSWORD_MIN_LENGTH = 4

/** BCrypt silently ignores input past 72 bytes, so reject it rather than truncate it. */
const val PASSWORD_MAX_LENGTH = 72

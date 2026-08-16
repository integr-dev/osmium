package net.integr.osmium.account.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.security.SecurityRequirements
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import net.integr.osmium.account.dto.LoginRequest
import net.integr.osmium.account.dto.LoginResponse
import net.integr.osmium.account.dto.PasswordChangeRequest
import net.integr.osmium.account.dto.SessionResponse
import net.integr.osmium.account.dto.UserResponse
import net.integr.osmium.account.service.AuthService
import net.integr.osmium.account.service.IssuedSession
import net.integr.osmium.account.service.UserService
import net.integr.osmium.security.JwtProperties
import net.integr.osmium.security.RefreshCookie
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.CookieValue
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.time.Duration
import java.time.Instant

@RestController
@RequestMapping("/api/auth")
@Tag(name = "Authentication", description = "Sessions, password rotation and self lookup.")
class AuthController(
    private val authService: AuthService,
    private val userService: UserService,
    private val jwtProperties: JwtProperties,
) {
    @PostMapping("/login")
    @SecurityRequirements
    @Operation(
        summary = "Exchange credentials for a session.",
        description = "The access token comes back in the body, for the caller to hold in memory. " +
            "The refresh token is set as an HttpOnly cookie and never reaches JavaScript.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Session started."),
        ApiResponse(responseCode = "401", description = "Unknown username or wrong password."),
    )
    fun login(@Valid @RequestBody request: LoginRequest): ResponseEntity<LoginResponse> =
        respondWith(authService.login(request))

    /**
     * Authenticated by the cookie alone. Requiring a Bearer token here would defeat the purpose:
     * the case this exists for is precisely the one where the access token has expired.
     */
    @PostMapping("/refresh")
    @SecurityRequirements
    @Operation(
        summary = "Mint a new access token from the refresh cookie.",
        description = "Rotates: the presented token is spent and a successor replaces the cookie. " +
            "The session expiry does not move, so refreshing cannot extend a session past its login.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "A new access token, and a rotated cookie."),
        ApiResponse(
            responseCode = "401",
            description = "No cookie, or a token that is unknown, expired, revoked or replayed. " +
                "A replay revokes every session descended from that login.",
        ),
    )
    fun refresh(
        @CookieValue(name = RefreshCookie.NAME, required = false) refreshToken: String?,
    ): ResponseEntity<LoginResponse> {
        if (refreshToken.isNullOrBlank()) throw BadCredentialsException("Session expired")
        return respondWith(authService.refresh(refreshToken))
    }

    /**
     * Clears the cookie whatever happened, including for a token already revoked. A logout that
     * reports failure would leave the operator holding a cookie they cannot get rid of.
     */
    @PostMapping("/logout")
    @SecurityRequirements
    @Operation(
        summary = "End the current session.",
        description = "Revokes the refresh token and every successor of it, then clears the cookie.",
    )
    @ApiResponses(ApiResponse(responseCode = "204", description = "Session ended, cookie cleared."))
    fun logout(
        @CookieValue(name = RefreshCookie.NAME, required = false) refreshToken: String?,
    ): ResponseEntity<Void> {
        authService.logout(refreshToken)
        return ResponseEntity.noContent()
            .header(HttpHeaders.SET_COOKIE, RefreshCookie.clear(jwtProperties.cookieSecure).toString())
            .build()
    }

    /** The cookie expires with the token, so a spent session leaves nothing behind in the browser. */
    private fun respondWith(session: IssuedSession): ResponseEntity<LoginResponse> {
        val cookie = RefreshCookie.issue(
            value = session.refresh.value,
            maxAge = Duration.between(Instant.now(), session.refresh.expiresAt),
            secure = jwtProperties.cookieSecure,
        )
        return ResponseEntity.ok()
            .header(HttpHeaders.SET_COOKIE, cookie.toString())
            .body(session.access)
    }

    @PostMapping("/password")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Operation(
        summary = "Rotate the password of the authenticated account.",
        description = "Requires the current password. Any authenticated account may call this for itself.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Password changed."),
        ApiResponse(responseCode = "400", description = "New password rejected."),
        ApiResponse(responseCode = "401", description = "Missing token or wrong current password."),
    )
    fun changePassword(
        @Valid @RequestBody request: PasswordChangeRequest,
        authentication: Authentication,
    ) = authService.changePassword(username = authentication.name, request = request)

    /**
     * The only way the person a replay happened to ever hears about it. The trail records it behind
     * `audit.read`, which reaches an administrator and not them.
     */
    @PostMapping("/session-alert/acknowledge")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('user.read.self')")
    @Operation(
        summary = "Dismiss the replayed-session notice.",
        description = "Marks it read. A later replay raises it again.",
    )
    @ApiResponses(ApiResponse(responseCode = "204", description = "Notice dismissed."))
    fun acknowledgeSessionAlert(authentication: Authentication) =
        authService.acknowledgeSessionAlert(authentication.name)

    @GetMapping("/sessions")
    @PreAuthorize("hasAuthority('user.read.self')")
    @Operation(
        summary = "The account's own live sessions.",
        description = "Only the tip of each rotation chain, with the caller's own marked. The " +
            "address is only meaningful where the deployment's proxy headers are trusted, and the " +
            "user agent is self-declared by the browser.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Live sessions, newest first."),
        ApiResponse(responseCode = "401", description = "Missing or invalid token."),
    )
    fun sessions(
        authentication: Authentication,
        @CookieValue(name = RefreshCookie.NAME, required = false) refreshToken: String?,
    ): List<SessionResponse> = authService.sessions(username = authentication.name, rawToken = refreshToken)

    @DeleteMapping("/sessions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('user.read.self')")
    @Operation(
        summary = "End one of your own sessions.",
        description = "Ending the current one leaves this browser signed out at the next refresh.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Session ended."),
        ApiResponse(
            responseCode = "404",
            description = "No such session **for this account**. Another operator's session is " +
                "reported the same way as one that does not exist.",
        ),
    )
    fun endSession(@PathVariable id: Long, authentication: Authentication) {
        if (!authService.endSession(username = authentication.name, sessionId = id)) {
            throw NoSuchElementException("No such session")
        }
    }

    /**
     * Ends the caller's session too, deliberately. Someone reaching for this believes they have
     * been compromised, and the version that spares the current session spares the attacker's if
     * the attacker is the one clicking it.
     */
    @PostMapping("/sessions/revoke-all")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('user.read.self')")
    @Operation(
        summary = "Sign out of every session, everywhere.",
        description = "Revokes every refresh token **and** every access token already issued — the " +
            "latter is what a password change alone did not do.",
    )
    @ApiResponses(ApiResponse(responseCode = "204", description = "Every session ended."))
    fun revokeAllSessions(authentication: Authentication): ResponseEntity<Void> {
        authService.endAllSessions(authentication.name)
        return ResponseEntity.noContent()
            .header(HttpHeaders.SET_COOKIE, RefreshCookie.clear(jwtProperties.cookieSecure).toString())
            .build()
    }

    @GetMapping("/me")
    @PreAuthorize("hasAuthority('user.read.self')")
    @Operation(summary = "Return the authenticated account.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The current account."),
        ApiResponse(responseCode = "401", description = "Missing or invalid token."),
        ApiResponse(responseCode = "403", description = "Missing node `user.read.self`."),
    )
    fun me(authentication: Authentication): UserResponse =
        userService.findByUsername(authentication.name)
}

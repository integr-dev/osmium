package net.integr.osmium.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.security.SecurityRequirements
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import net.integr.osmium.dto.LoginRequest
import net.integr.osmium.dto.LoginResponse
import net.integr.osmium.dto.PasswordChangeRequest
import net.integr.osmium.dto.UserResponse
import net.integr.osmium.service.AuthService
import net.integr.osmium.service.UserService
import org.springframework.http.HttpStatus
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/auth")
@Tag(name = "Authentication", description = "Login, password rotation and self lookup.")
class AuthController(
    private val authService: AuthService,
    private val userService: UserService,
) {
    @PostMapping("/login")
    @SecurityRequirements
    @Operation(summary = "Exchange credentials for an access token.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Token issued."),
        ApiResponse(responseCode = "401", description = "Unknown username or wrong password."),
    )
    fun login(@Valid @RequestBody request: LoginRequest): LoginResponse = authService.login(request)

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

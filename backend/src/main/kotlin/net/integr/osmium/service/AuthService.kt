package net.integr.osmium.service

import net.integr.osmium.dto.LoginRequest
import net.integr.osmium.dto.LoginResponse
import net.integr.osmium.dto.PasswordChangeRequest
import net.integr.osmium.model.AuditAction
import net.integr.osmium.repository.UserRepository
import net.integr.osmium.security.JwtService
import net.integr.osmium.security.encodeRequired
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service
@Transactional(readOnly = true)
class AuthService(
    private val userRepository: UserRepository,
    private val passwordEncoder: PasswordEncoder,
    private val jwtService: JwtService,
    private val auditService: AuditService,
) {
    fun login(request: LoginRequest): LoginResponse {
        val user = userRepository.findByUsername(request.username)
            ?: throw BadCredentialsException(INVALID_CREDENTIALS)

        if (!passwordEncoder.matches(request.password, user.passwordHash)) {
            throw BadCredentialsException(INVALID_CREDENTIALS)
        }

        val token = jwtService.issue(user)
        return LoginResponse(token = token.value, expiresAt = token.expiresAt)
    }

    @Transactional
    fun changePassword(username: String, request: PasswordChangeRequest) {
        val user = userRepository.findByUsername(username)
            ?: throw BadCredentialsException(INVALID_CREDENTIALS)

        if (!passwordEncoder.matches(request.currentPassword, user.passwordHash)) {
            throw BadCredentialsException(INVALID_CREDENTIALS)
        }
        require(request.newPassword != request.currentPassword) {
            "New password must differ from the current password"
        }

        user.passwordHash = passwordEncoder.encodeRequired(request.newPassword)
        // That it happened, and by whom. Neither password reaches the entry.
        auditService.record(
            action = AuditAction.USER_PASSWORD_CHANGE,
            target = user.username,
            detail = "Changed their own password",
        )
    }

    private companion object {
        const val INVALID_CREDENTIALS = "Invalid username or password"
    }
}

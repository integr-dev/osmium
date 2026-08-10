package net.integr.osmium.service

import net.integr.osmium.dto.CreateUserRequest
import net.integr.osmium.dto.UpdateRoleRequest
import net.integr.osmium.dto.UpdateSelfRequest
import net.integr.osmium.dto.UpdateUserRequest
import net.integr.osmium.dto.UserResponse
import net.integr.osmium.dto.toResponse
import net.integr.osmium.model.Role
import net.integr.osmium.model.User
import net.integr.osmium.repository.RoleRepository
import net.integr.osmium.repository.UserRepository
import net.integr.osmium.security.encodeRequired
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service
@Transactional(readOnly = true)
class UserService(
    private val userRepository: UserRepository,
    private val roleRepository: RoleRepository,
    private val passwordEncoder: PasswordEncoder,
) {
    fun findAll(): List<UserResponse> =
        userRepository.findAll().sortedBy { it.username }.map { it.toResponse() }

    fun findByUsername(username: String): UserResponse =
        (userRepository.findByUsername(username) ?: throw NoSuchElementException("No user named '$username'"))
            .toResponse()

    @Transactional
    fun create(request: CreateUserRequest): UserResponse {
        check(!userRepository.existsByUsername(request.username)) {
            "Username '${request.username}' is already taken"
        }

        val user = User(
            username = request.username,
            passwordHash = passwordEncoder.encodeRequired(request.password),
            role = resolveRole(name = request.role),
        )
        return userRepository.save(user).toResponse()
    }

    /** Self-service edit. Cannot touch the role or the password. */
    @Transactional
    fun updateSelf(actorUsername: String, request: UpdateSelfRequest): UserResponse {
        val user = userRepository.findByUsername(actorUsername)
            ?: throw NoSuchElementException("No user named '$actorUsername'")
        rename(user = user, username = request.username)
        return user.toResponse()
    }

    /**
     * Administrative edit of *another* account, including resetting its password without knowing the
     * old one. Self-edits are refused here: they belong on `PATCH /api/users/me` for the username
     * and `POST /api/auth/password` for the password, so an administrator can never change their own
     * password without proving they know the current one.
     */
    @Transactional
    fun update(id: Long, request: UpdateUserRequest, actorUsername: String): UserResponse {
        val user = userRepository.findById(id).orElseThrow { NoSuchElementException("No user with id $id") }
        check(user.username != actorUsername) {
            "An account cannot edit itself here; use PATCH /api/users/me or POST /api/auth/password"
        }
        rename(user = user, username = request.username)
        request.password?.let { user.passwordHash = passwordEncoder.encodeRequired(it) }
        return user.toResponse()
    }

    @Transactional
    fun delete(id: Long, actorUsername: String) {
        val user = userRepository.findById(id).orElseThrow { NoSuchElementException("No user with id $id") }
        check(user.username != actorUsername) { "An account cannot delete itself" }
        userRepository.delete(user)
    }

    @Transactional
    fun replaceRole(id: Long, request: UpdateRoleRequest, actorUsername: String): UserResponse {
        val user = userRepository.findById(id).orElseThrow { NoSuchElementException("No user with id $id") }
        // Blocks self-demotion, which would strip user.role.write and leave nobody able to undo it.
        check(user.username != actorUsername) { "An account cannot change its own role" }
        user.role = resolveRole(name = request.role)
        return user.toResponse()
    }

    private fun rename(user: User, username: String) {
        if (username == user.username) return
        check(!userRepository.existsByUsername(username)) { "Username '$username' is already taken" }
        user.username = username
    }

    private fun resolveRole(name: String?): Role? {
        if (name == null) return null
        return roleRepository.findByName(name) ?: throw IllegalArgumentException("Unknown role: $name")
    }
}

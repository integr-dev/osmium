package net.integr.osmium.service

import net.integr.osmium.dto.CreateUserRequest
import net.integr.osmium.dto.UpdateRolesRequest
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
            roles = resolveRoles(names = request.roles),
        )
        return userRepository.save(user).toResponse()
    }

    /** Self-service edit. Cannot touch roles or the password. */
    @Transactional
    fun updateSelf(actorUsername: String, request: UpdateSelfRequest): UserResponse {
        val user = userRepository.findByUsername(actorUsername)
            ?: throw NoSuchElementException("No user named '$actorUsername'")
        rename(user = user, username = request.username)
        return user.toResponse()
    }

    /** Administrative edit of any account, including resetting the password without the old one. */
    @Transactional
    fun update(id: Long, request: UpdateUserRequest): UserResponse {
        val user = userRepository.findById(id).orElseThrow { NoSuchElementException("No user with id $id") }
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
    fun replaceRoles(id: Long, request: UpdateRolesRequest): UserResponse {
        val user = userRepository.findById(id).orElseThrow { NoSuchElementException("No user with id $id") }
        user.roles = resolveRoles(names = request.roles)
        return user.toResponse()
    }

    private fun rename(user: User, username: String) {
        if (username == user.username) return
        check(!userRepository.existsByUsername(username)) { "Username '$username' is already taken" }
        user.username = username
    }

    private fun resolveRoles(names: Set<String>): MutableSet<Role> {
        if (names.isEmpty()) return mutableSetOf()

        val roles = roleRepository.findAllByNameIn(names)
        val missing = names - roles.mapTo(mutableSetOf()) { it.name }
        require(missing.isEmpty()) { "Unknown roles: ${missing.sorted().joinToString()}" }

        return roles.toMutableSet()
    }
}

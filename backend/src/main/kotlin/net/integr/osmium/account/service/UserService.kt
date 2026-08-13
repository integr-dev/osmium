package net.integr.osmium.account.service

import net.integr.osmium.account.dto.CreateUserRequest
import net.integr.osmium.account.dto.UpdateRoleRequest
import net.integr.osmium.account.dto.UpdateSelfRequest
import net.integr.osmium.account.dto.UpdateUserRequest
import net.integr.osmium.account.dto.UserResponse
import net.integr.osmium.account.dto.toResponse
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.account.model.Role
import net.integr.osmium.account.model.User
import net.integr.osmium.account.repository.RoleRepository
import net.integr.osmium.account.repository.UserRepository
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.security.encodeRequired
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import net.integr.osmium.audit.service.AuditService

@Service
@Transactional(readOnly = true)
class UserService(
    private val userRepository: UserRepository,
    private val roleRepository: RoleRepository,
    private val passwordEncoder: PasswordEncoder,
    private val auditService: AuditService,
    private val broker: LiveUpdateBroker,
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
        val saved = userRepository.save(user)
        // The chosen password is never recorded, here or anywhere else in this trail.
        auditService.record(
            action = AuditAction.USER_CREATE,
            target = saved.username,
            detail = "Created with role ${saved.role?.name ?: "none"}",
        )
        publish(saved)
        return saved.toResponse()
    }

    /** Self-service edit. Cannot touch the role or the password. */
    @Transactional
    fun updateSelf(actorUsername: String, request: UpdateSelfRequest): UserResponse {
        val user = userRepository.findByUsername(actorUsername)
            ?: throw NoSuchElementException("No user named '$actorUsername'")

        val previous = user.username
        rename(user = user, username = request.username)
        // A rename changes the name every earlier entry was recorded under, so the trail needs the
        // link between them or it reads as two unrelated accounts.
        if (user.username != previous) {
            auditService.record(
                action = AuditAction.USER_UPDATE,
                target = user.username,
                detail = "Renamed themselves from $previous",
            )
        }
        publish(user)
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
        val previous = user.username
        rename(user = user, username = request.username)
        request.password?.let { user.passwordHash = passwordEncoder.encodeRequired(it) }

        val changes = buildList {
            if (user.username != previous) add("renamed from $previous")
            // That a password was reset, never what it was set to.
            if (request.password != null) add("password reset by an administrator")
        }
        if (changes.isNotEmpty()) {
            auditService.record(
                action = AuditAction.USER_UPDATE,
                target = user.username,
                detail = changes.joinToString("; "),
            )
        }
        publish(user)
        return user.toResponse()
    }

    @Transactional
    fun delete(id: Long, actorUsername: String) {
        val user = userRepository.findById(id).orElseThrow { NoSuchElementException("No user with id $id") }
        check(user.username != actorUsername) { "An account cannot delete itself" }

        val username = user.username
        val role = user.role?.name ?: "none"
        // Sessions go with the account, by the cascade mapped on User.refreshTokens.
        userRepository.delete(user)
        auditService.record(
            action = AuditAction.USER_DELETE,
            target = username,
            detail = "Held role $role",
        )
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.USER_REMOVED, data = mapOf("id" to id)))
    }

    @Transactional
    fun replaceRole(id: Long, request: UpdateRoleRequest, actorUsername: String): UserResponse {
        val user = userRepository.findById(id).orElseThrow { NoSuchElementException("No user with id $id") }
        // Blocks self-demotion, which would strip user.role.write and leave nobody able to undo it.
        check(user.username != actorUsername) { "An account cannot change its own role" }

        val previous = user.role?.name ?: "none"
        user.role = resolveRole(name = request.role)
        // The single most consequential entry in the trail: it is how authority is granted.
        auditService.record(
            action = AuditAction.USER_ROLE_CHANGE,
            target = user.username,
            detail = "$previous → ${user.role?.name ?: "none"}",
        )
        publish(user)
        publishPermissions(user)
        return user.toResponse()
    }

    /** Keeps the account list current for whoever administers accounts. */
    private fun publish(user: User) =
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.USER_CHANGED, data = user.toResponse()))

    /**
     * Tells one account that what it may do has changed.
     *
     * The backend already enforces a role change on the subject's next request, since authorities
     * resolve from the database every time. Their browser learned what it may do once, at login, and
     * without this keeps offering buttons that now fail — which reads as the app being broken rather
     * than as access having changed. The payload is what `GET /api/auth/me` returns, so the client
     * replaces its copy rather than refetching.
     *
     * Only from here, and deliberately not from the two paths that rename an account. A rename moves
     * the name the subscriber is known by, so an event addressed to the new one could never reach
     * the stream opened under the old one — and it does not need to: renaming ends the session, and
     * the stream closes on the next tick when the old name resolves to no nodes at all.
     */
    private fun publishPermissions(user: User) = broker.publish(
        LiveUpdateEvent(
            type = LiveUpdateType.PERMISSIONS_CHANGED,
            data = user.toResponse(),
            username = user.username,
        ),
    )

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

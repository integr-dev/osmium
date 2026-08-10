package net.integr.osmium.config

import net.integr.osmium.model.PermissionNode
import net.integr.osmium.model.Role
import net.integr.osmium.model.User
import net.integr.osmium.repository.PermissionNodeRepository
import net.integr.osmium.repository.RoleRepository
import net.integr.osmium.repository.UserRepository
import net.integr.osmium.security.Nodes
import net.integr.osmium.security.RoleDefinitions
import net.integr.osmium.security.RoleNames
import net.integr.osmium.security.encodeRequired
import org.slf4j.LoggerFactory
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Transactional

/**
 * Seeds the authorization model on every boot. Nodes and role→node mappings are re-synced from
 * [Nodes] / [RoleDefinitions] so the code stays the source of truth; the bootstrap account is only
 * created while no user exists at all.
 */
@Component
class DataInitializer(
    private val permissionNodeRepository: PermissionNodeRepository,
    private val roleRepository: RoleRepository,
    private val userRepository: UserRepository,
    private val passwordEncoder: PasswordEncoder,
    private val bootstrapProperties: BootstrapProperties,
) : ApplicationRunner {

    private val log = LoggerFactory.getLogger(javaClass)

    @Transactional
    override fun run(args: ApplicationArguments) {
        val nodes = syncNodes()
        syncRoles(nodes = nodes)
        pruneRemovedNodes()
        createBootstrapAccountIfNoUsersExist()
    }

    private fun syncNodes(): Map<String, PermissionNode> {
        val existing = permissionNodeRepository.findAll().associateBy { it.id }
        val created = (Nodes.ALL - existing.keys)
            .map { permissionNodeRepository.save(PermissionNode(id = it)) }
            .associateBy { it.id }

        if (created.isNotEmpty()) log.info("Seeded permission nodes: {}", created.keys.sorted())
        return existing + created
    }

    private fun syncRoles(nodes: Map<String, PermissionNode>) {
        RoleDefinitions.ALL.forEach { definition ->
            val role = roleRepository.findByName(definition.name) ?: Role(name = definition.name)
            val desired = definition.nodes.mapTo(mutableSetOf()) { id ->
                requireNotNull(nodes[id]) { "Role '${definition.name}' references unseeded node '$id'" }
            }

            if (role.id == null || role.nodes.mapTo(mutableSetOf()) { it.id } != definition.nodes) {
                role.nodes = desired
                roleRepository.save(role)
                log.info("Synced role '{}' with nodes {}", definition.name, definition.nodes.sorted())
            }
        }
    }

    /**
     * Drops nodes that no longer appear in [Nodes]. Without this a renamed node leaves its old row
     * behind forever, granting nothing but implying it still exists.
     *
     * Runs after [syncRoles] and flushes first, so the `role_nodes` rows that referenced it are
     * already gone by the time the node itself is deleted.
     */
    private fun pruneRemovedNodes() {
        val removed = permissionNodeRepository.findAll().filter { it.id !in Nodes.ALL }
        if (removed.isEmpty()) return

        permissionNodeRepository.flush()
        permissionNodeRepository.deleteAll(removed)
        log.info("Removed permission nodes no longer defined in code: {}", removed.map { it.id }.sorted())
    }

    private fun createBootstrapAccountIfNoUsersExist() {
        if (userRepository.count() > 0) return

        val administrator = requireNotNull(roleRepository.findByName(RoleNames.ADMINISTRATOR)) {
            "Administrator role was not seeded"
        }
        val user = User(
            username = bootstrapProperties.username,
            passwordHash = passwordEncoder.encodeRequired(bootstrapProperties.password),
            role = administrator,
        )
        userRepository.save(user)

        log.warn(
            "Seeded bootstrap account '{}' with full administrator nodes. Nothing forces its " +
                "password to be rotated - set OSMIUM_BOOTSTRAP_PASSWORD before first boot.",
            user.username,
        )
    }
}

package net.integr.osmium.security

/**
 * Canonical permission nodes. Routes are annotated with the literal string
 * (`@PreAuthorize("hasAuthority('user.create')")`) so the check stays greppable; this object is the
 * seed source of truth and must stay in sync with those annotations.
 */
object Nodes {
    const val USER_READ_SELF = "user.read.self"
    const val USER_EDIT_SELF = "user.edit.self"
    const val USER_READ = "user.read"
    const val USER_EDIT = "user.edit"
    const val USER_CREATE = "user.create"
    const val USER_DELETE = "user.delete"
    const val USER_ROLES_WRITE = "user.roles.write"
    const val ROLE_READ = "role.read"

    val ALL: Set<String> = setOf(
        USER_READ_SELF,
        USER_EDIT_SELF,
        USER_READ,
        USER_EDIT,
        USER_CREATE,
        USER_DELETE,
        USER_ROLES_WRITE,
        ROLE_READ,
    )
}

object RoleNames {
    const val VIEWER = "viewer"
    const val ORCHESTRATOR = "orchestrator"
    const val ADMINISTRATOR = "administrator"
}

data class RoleDefinition(val name: String, val nodes: Set<String>)

/**
 * The roles seeded on every boot.
 *
 * Inheritance is materialised here rather than walked at check time: each tier unions the tier
 * below it, and [net.integr.osmium.config.DataInitializer] writes the flattened result into
 * `role_nodes`. That keeps authorization a single flat set lookup and keeps the table
 * self-describing. Changing the hierarchy is a code change plus a restart.
 */
object RoleDefinitions {
    private val VIEWER_NODES: Set<String> = setOf(
        Nodes.USER_READ_SELF,
        Nodes.USER_EDIT_SELF,
    )

    private val ORCHESTRATOR_NODES: Set<String> = VIEWER_NODES + setOf(
        Nodes.USER_READ,
    )

    private val ADMINISTRATOR_NODES: Set<String> = ORCHESTRATOR_NODES + setOf(
        Nodes.USER_EDIT,
        Nodes.USER_CREATE,
        Nodes.USER_DELETE,
        Nodes.USER_ROLES_WRITE,
        Nodes.ROLE_READ,
    )

    val ALL: List<RoleDefinition> = listOf(
        RoleDefinition(name = RoleNames.VIEWER, nodes = VIEWER_NODES),
        RoleDefinition(name = RoleNames.ORCHESTRATOR, nodes = ORCHESTRATOR_NODES),
        RoleDefinition(name = RoleNames.ADMINISTRATOR, nodes = ADMINISTRATOR_NODES),
    )
}

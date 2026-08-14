package net.integr.osmium.security
import net.integr.osmium.account.config.DataInitializer
import net.integr.osmium.account.model.Role

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
    const val USER_ROLE_WRITE = "user.role.write"

    /**
     * End every session an account holds. Separate from editing it because the two are different
     * acts: renaming somebody is administration, signing them out of every device is a security
     * response, and an account can be trusted with the first without the second.
     */
    const val USER_SESSIONS_REVOKE = "user.sessions.revoke"

    const val ROLE_READ = "role.read"

    /**
     * Read the operator audit trail: who triggered which command, and the text of anything an agent was
     * made to say. Deliberately its own family - an orchestrator running the fleet does not
     * automatically get to read every other operator's actions.
     */
    const val AUDIT_READ = "audit.read"

    /**
     * Pull the trail out as a file. Separate from reading it because the two carry different risk:
     * reading is bounded and stays inside Osmium, where the next read is itself observable, while an
     * export leaves as a copy nothing here can see again. Splitting them lets an account be trusted
     * to look without being trusted to take.
     */
    const val AUDIT_EXPORT = "audit.export"

    /**
     * What was said in game, and saying something.
     *
     * Read is separate from `agent.read` because chat is content rather than state: knowing which
     * agents are online is not the same as reading what everyone on the server said, including what
     * was said to the agents.
     *
     * Speaking is impersonation - the message goes out under a Minecraft account and everyone there
     * reads it as that player talking - so it is the furthest of the two from reading, not a write
     * verb on a feed. Rate limited per agent besides: chat spam is the fastest route to a ban, and
     * the ban lands on the account rather than on the operator.
     */
    const val CHAT_READ = "chat.read"
    const val CHAT_SPEAK = "chat.speak"

    /** Incidents: what went wrong, and to which agent. */
    const val ACTIVITY_READ = "activity.read"

    /**
     * The agents themselves: which exist, where they are and how they are doing. Also the player
     * heads, which only ever appear beside an agent or a line it heard.
     */
    const val AGENT_READ = "agent.read"

    /**
     * Acting on agents, split by what the act costs.
     *
     * `run` is the all-day verb and undoes itself - an agent connected by mistake is disconnected
     * again. `write` reshapes the fleet but leaves it recoverable. `delete` takes an agent and its
     * history with it. Holding the first without the last is the common case, and the reason these
     * are three nodes rather than one.
     */
    const val AGENT_RUN = "agent.run"
    const val AGENT_WRITE = "agent.write"
    const val AGENT_DELETE = "agent.delete"

    /**
     * Ask the host to log this agent in. See FLEET_CONNECTIVITY.md: the credential never reaches
     * Osmium, but deciding that a login should happen at all is still its own authority.
     */
    const val AGENT_SETUP = "agent.setup"

    /**
     * The machines the agents run on. Reading them is its own node because a host list is
     * infrastructure - addresses, versions, what runs where - rather than fleet state.
     */
    const val HOST_READ = "host.read"

    /**
     * `token` is the enrolment credential: rotating it shows a new one once and leaves the running
     * host unable to report until it is re-enrolled. `delete` removes the host and orphans every
     * agent on it. Neither is something a rename should carry with it, which is what happened while
     * all three sat behind one node.
     */
    const val HOST_WRITE = "host.write"
    const val HOST_TOKEN = "host.token"
    const val HOST_DELETE = "host.delete"

    val ALL: Set<String> = setOf(
        USER_READ_SELF,
        USER_EDIT_SELF,
        USER_READ,
        USER_EDIT,
        USER_CREATE,
        USER_DELETE,
        USER_ROLE_WRITE,
        USER_SESSIONS_REVOKE,
        ROLE_READ,
        AUDIT_READ,
        AUDIT_EXPORT,
        AGENT_READ,
        HOST_READ,
        CHAT_READ,
        CHAT_SPEAK,
        ACTIVITY_READ,
        AGENT_RUN,
        AGENT_WRITE,
        AGENT_DELETE,
        AGENT_SETUP,
        HOST_WRITE,
        HOST_TOKEN,
        HOST_DELETE,
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
    /**
     * Read-only throughout. The four read nodes gate listing hosts and agents, the feeds and the
     * live streams, and nothing else — every way to change the fleet is a separate node — so a
     * viewer watches the fleet without being able to touch it.
     */
    private val VIEWER_NODES: Set<String> = setOf(
        Nodes.USER_READ_SELF,
        Nodes.USER_EDIT_SELF,
        // Role definitions are not sensitive, and every account needs them to see where its own
        // tier sits in the ladder.
        Nodes.ROLE_READ,
        Nodes.AGENT_READ,
        Nodes.HOST_READ,
        Nodes.CHAT_READ,
        Nodes.ACTIVITY_READ,
    )

    /**
     * Adds running the fleet: connecting agents, setting them up, reshaping which server they sit
     * on, and speaking as them.
     *
     * **Not the two deletions.** An orchestrator runs the fleet all day and has no need to destroy
     * part of it, and that distinction is the point of splitting acting on the fleet up — an agent is
     * gone with its history, and a host takes every agent on it. Both now sit with the tier that
     * already carries the irreversible operations.
     */
    private val ORCHESTRATOR_NODES: Set<String> = VIEWER_NODES + setOf(
        Nodes.AGENT_RUN,
        Nodes.AGENT_WRITE,
        Nodes.AGENT_SETUP,
        Nodes.CHAT_SPEAK,
        Nodes.HOST_WRITE,
        Nodes.HOST_TOKEN,
    )

    /** Adds user management, the audit trail and everything irreversible. */
    private val ADMINISTRATOR_NODES: Set<String> = ORCHESTRATOR_NODES + setOf(
        Nodes.AGENT_DELETE,
        Nodes.HOST_DELETE,
        Nodes.USER_READ,
        Nodes.USER_EDIT,
        Nodes.USER_CREATE,
        Nodes.USER_DELETE,
        Nodes.USER_ROLE_WRITE,
        Nodes.USER_SESSIONS_REVOKE,
        Nodes.AUDIT_READ,
        Nodes.AUDIT_EXPORT,
    )

    val ALL: List<RoleDefinition> = listOf(
        RoleDefinition(name = RoleNames.VIEWER, nodes = VIEWER_NODES),
        RoleDefinition(name = RoleNames.ORCHESTRATOR, nodes = ORCHESTRATOR_NODES),
        RoleDefinition(name = RoleNames.ADMINISTRATOR, nodes = ADMINISTRATOR_NODES),
    )
}

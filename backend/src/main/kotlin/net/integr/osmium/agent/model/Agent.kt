package net.integr.osmium.agent.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.FetchType
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.Table
import net.integr.osmium.host.model.Host
import java.time.Instant

/**
 * Lifecycle of an agent as the backend sees it. The backend never observes the Minecraft connection
 * directly - it knows the last thing the host reported plus whether that host is reachable.
 */
enum class AgentState {
    /** Created, but no Minecraft account set up on the host yet. */
    UNLINKED,

    /** `setup_agent` sent; the host is authenticating by means the backend does not observe. */
    SETUP_PENDING,

    /** The host holds credentials for this agent. Not in game. */
    LINKED,

    ONLINE,

    /** The host's stored credentials were rejected. Cannot self-heal; needs a fresh setup. */
    NEEDS_RELINK,

    /** The Minecraft server refused the connection - whitelist, ban, version mismatch. */
    CONNECT_FAILED,

    /** The owning host is unreachable, so the real state is unknown. Never rendered as offline. */
    STALE,
}

@Entity
@Table(name = "agents")
class Agent(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @Column(name = "label", nullable = false, unique = true, length = 64)
    var label: String = "",

    @ManyToOne(fetch = FetchType.EAGER, optional = false)
    @JoinColumn(name = "host_id", nullable = false)
    var host: Host = Host(),

    /** Target Minecraft server. Configuration, not a credential, so the backend owns it. */
    @Column(name = "server_address", nullable = false, length = 128)
    var serverAddress: String = "",

    @Enumerated(EnumType.STRING)
    @Column(name = "state", nullable = false, length = 32)
    var state: AgentState = AgentState.UNLINKED,

    /** Reported by the host after a successful setup. Identity only - never a credential. */
    @Column(name = "mc_username", length = 32)
    var mcUsername: String? = null,

    @Column(name = "mc_uuid", length = 64)
    var mcUuid: String? = null,

    /**
     * When the host last reported this agent as `ONLINE`, or null when it is not.
     *
     * Exists for chat listener election, which picks the longest-running session on a server: the
     * incumbent has already proved it can hold a connection, so choosing it churns the feed least.
     * Reset on every entry into `ONLINE` rather than accumulated, since a reconnect starts a new
     * session and an agent that keeps dropping should not out-rank one that never has.
     */
    @Column(name = "online_since")
    var onlineSince: Instant? = null,

    /**
     * Whether this agent is the one forwarding its server's global chat.
     *
     * One per **server**, not per host or per fleet - see FLEET_CONNECTIVITY.md. Stored rather than
     * derived because it is a fact about what the host was told, not a preference the backend can
     * recompute: a restart must not silently disagree with what agents are actually doing.
     *
     * Only ever set once the command has been written to the host, so it never claims a listener
     * that was never told to listen.
     *
     * The database default is not decoration. A `not null` column with no default cannot be added to
     * a table that already has rows, so `ddl-auto=update` emits the `alter table`, Postgres rejects
     * it, and the application starts anyway against a schema missing the column - which surfaces
     * later as a failing select rather than as a failure to boot. Tests never catch it, because
     * Testcontainers builds the schema fresh every run. See the backend README.
     */
    @Column(name = "chat_listener", nullable = false, columnDefinition = "boolean not null default false")
    var chatListener: Boolean = false,
) {
    /**
     * What the operator should see. A reachable host's report is trusted; an unreachable host means
     * the stored state is stale regardless of what it last said.
     */
    fun effectiveState(): AgentState =
        if (!host.isReachable() && state == AgentState.ONLINE) AgentState.STALE else state
}

package net.integr.osmium.model

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

/**
 * Lifecycle of a bot as the backend sees it. The backend never observes the Minecraft connection
 * directly - it knows the last thing the agent reported plus whether that agent is reachable.
 */
enum class BotState {
    /** Created, but no Minecraft account set up on the host yet. */
    UNLINKED,

    /** `setup_bot` sent; the host is authenticating by means the backend does not observe. */
    SETUP_PENDING,

    /** The host holds credentials for this bot. Not in game. */
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
@Table(name = "bots")
class Bot(
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
    var state: BotState = BotState.UNLINKED,

    /** Reported by the host after a successful setup. Identity only - never a credential. */
    @Column(name = "mc_username", length = 32)
    var mcUsername: String? = null,

    @Column(name = "mc_uuid", length = 64)
    var mcUuid: String? = null,
) {
    /**
     * What the operator should see. A reachable host's report is trusted; an unreachable host means
     * the stored state is stale regardless of what it last said.
     */
    fun effectiveState(): BotState =
        if (!host.isReachable() && state == BotState.ONLINE) BotState.STALE else state
}

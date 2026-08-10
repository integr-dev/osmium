package net.integr.osmium.chat.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import java.time.Instant

/**
 * Which conversation a line belongs to. **Classified by the host**, which is the only place the raw
 * packet types are visible - the backend cannot infer scope from message text. See the Chat section
 * of FLEET_CONNECTIVITY.md.
 *
 * Adding a value here requires a manual `ALTER TABLE` against any existing database, for the reason
 * spelled out on [net.integr.osmium.audit.model.AuditEntry.action].
 */
enum class ChatScope {
    /** An operator made the agent speak. Also raises an audit entry, since a person caused it. */
    OUTBOUND,

    /** A player whispered the agent. */
    DIRECT,

    /** Proximity chat, where the server has it. */
    LOCAL,

    /**
     * Ordinary player chat everyone on the server sees. Forwarded by exactly one elected agent per
     * server, so it belongs to the *server* feed and is deliberately absent from the per-agent one -
     * otherwise the same message appears once per agent and drowns the conversation that is
     * actually about that agent.
     */
    GLOBAL,
}

/**
 * One line of Minecraft chat.
 *
 * The agent is referenced by **id and label as plain columns, not a relation**, matching
 * [net.integr.osmium.audit.model.AuditEntry]. Two reasons here: a server's global feed is forwarded
 * by whichever agent currently holds the listener role, and deleting that agent must not take the
 * server's history with it; and the label is what gets rendered, so keeping it means the feed still
 * reads correctly once the agent is gone.
 *
 * Kept for three days - the shortest of the three retentions, because this is the largest stream and
 * the only one full of other people's words.
 */
@Entity
@Table(
    name = "chat_messages",
    indexes = [
        // Both feeds are read newest-first from a keyset, so the sort columns follow the filter in
        // each index. Without them, paging deep into a busy server means sorting the whole table.
        Index(name = "idx_chat_messages_agent", columnList = "agent_id, at, id"),
        Index(name = "idx_chat_messages_server", columnList = "server_address, at, id"),
    ],
)
class ChatMessage(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    /**
     * When the backend received it, not when the host observed it.
     *
     * Host clocks are not synchronised with each other and a skewed one would file its chat into
     * the middle of the feed, or into the future - which for a cursor read newest-first means
     * either invisible or permanently at the top. Sub-second receive latency is the accepted cost.
     */
    @Column(name = "at", nullable = false)
    var at: Instant = Instant.now(),

    /** The agent that observed it. Not a foreign key, for the reason above; may dangle. */
    @Column(name = "agent_id")
    var agentId: Long? = null,

    @Column(name = "agent_label", nullable = false, length = 64)
    var agentLabel: String = "",

    /** The scope everything hangs off: one listener, one global feed, one build per server. */
    @Column(name = "server_address", nullable = false, length = 255)
    var serverAddress: String = "",

    @Enumerated(EnumType.STRING)
    @Column(name = "scope", nullable = false, length = 16)
    var scope: ChatScope = ChatScope.GLOBAL,

    /** Who said it in game. The agent's own label for [ChatScope.OUTBOUND]. */
    @Column(name = "sender", nullable = false, length = SENDER_MAX)
    var sender: String = "",

    /** `body`, because `text` is a type name in Postgres and a reserved word elsewhere. */
    @Column(name = "body", nullable = false, length = TEXT_MAX)
    var text: String = "",
) {
    companion object {
        const val SENDER_MAX = 64
        const val TEXT_MAX = 512
    }
}

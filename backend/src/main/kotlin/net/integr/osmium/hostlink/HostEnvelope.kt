package net.integr.osmium.hostlink

import tools.jackson.databind.JsonNode
import net.integr.osmium.host.model.Host

/**
 * Separates the three message lifecycles. Declared rather than inferred from [HostEnvelope.type],
 * so a new message type does not have to be classified in code to be handled correctly.
 */
enum class MessageKind {
    /** Backend to host. Carries an id and expects exactly one result. */
    COMMAND,

    /** Host to backend. Echoes the command id it resolves. */
    RESULT,

    /** Host to backend. Unsolicited, never awaited, no id. */
    EVENT,
}

/**
 * The single envelope on the backend↔host socket. See the "Wire protocol" section of
 * FLEET_CONNECTIVITY.md.
 *
 * There is no destination field: the connection *is* the host, chosen by resolving `agent.hostId`, so
 * re-encoding it would create a second source of truth. [agentId] routes within a host and is null for
 * host-scoped traffic such as heartbeats.
 *
 * [payload] stays a raw node on purpose. The envelope must parse without understanding the payload,
 * which is what lets a host running a newer version send something this backend can still log,
 * correlate and ignore instead of failing the whole message.
 */
data class HostEnvelope(
    val id: String? = null,
    val kind: MessageKind,
    val type: String,
    val agentId: Long? = null,
    val ok: Boolean? = null,
    val payload: JsonNode? = null,
)

/** Commands the backend sends. */
object CommandType {
    const val SETUP_AGENT = "setup_agent"
    const val CONNECT = "connect"
    const val DISCONNECT = "disconnect"
    const val CHAT = "chat"
    const val SET_CHAT_LISTENER = "set_chat_listener"
}

/** Events the backend understands. Anything else is logged and ignored, never fatal. */
object EventType {
    const val HEARTBEAT = "heartbeat"
    const val AGENT_STATUS = "agent_status"
    const val SETUP_RESULT = "setup_result"

    /**
     * What this host is, sent once when it connects:
     *
     * ```jsonc
     * { "agents": [ { "agentId": 12, "state": "ONLINE" } ],
     *   "loginMethods": [ { "id": "device_code", "label": "…", "description": "…" } ] }
     * ```
     *
     * **The agents.** State is *stored*, so it outlives the connection that reported it. A host
     * that restarts therefore leaves the backend asserting sessions nobody is running any more, and
     * nothing else in the protocol ever contradicts it - `agent_status` says what changed, never
     * what exists. So the host says what it has on arrival and the backend reconciles: an agent it
     * owns that goes unmentioned is not in game, whatever it was believed to be doing.
     *
     * **The login methods.** Which mechanisms this machine can actually perform, which only it
     * knows - see [LoginMethod]. Not stored, and a host that advertises none can set nothing up.
     *
     * Both are omissible and an absent key changes nothing, which is what lets the two halves of
     * this event arrive in different host versions.
     */
    const val HANDSHAKE = "handshake"

    /**
     * A line of Minecraft chat: `{ "scope": "global", "from": "Notch", "text": "…" }`.
     *
     * `scope` is one of `outbound`, `direct`, `local`, `global` and is **classified by the host** -
     * only it can see the raw packet types, and the backend cannot infer scope from message text.
     * A scope it does not recognise is dropped rather than guessed at.
     *
     * Includes the agent's own outbound messages, echoed back after they are actually said. The
     * backend does not record them on dispatch: what reached the server is what belongs in the feed.
     */
    const val CHAT = "chat"

    /**
     * Something that happened to an agent:
     * `{ "scope": "system", "severity": "warning", "text": "Kicked: flying is not enabled" }`.
     *
     * `scope` is `system` (the server acted on the agent) or `lifecycle` (the session changed).
     * `severity` is `info`, `warning` or `error`, and defaults to `info` when absent.
     *
     * Separate from [CHAT] on purpose: a kick between two lines of small talk is a kick nobody
     * sees. See the Chat section of FLEET_CONNECTIVITY.md.
     */
    const val ACTIVITY = "activity"
}

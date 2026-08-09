package net.integr.osmium.websocket

import tools.jackson.databind.JsonNode

/**
 * Separates the three message lifecycles. Declared rather than inferred from [AgentEnvelope.type],
 * so a new message type does not have to be classified in code to be handled correctly.
 */
enum class MessageKind {
    /** Backend to agent. Carries an id and expects exactly one result. */
    COMMAND,

    /** Agent to backend. Echoes the command id it resolves. */
    RESULT,

    /** Agent to backend. Unsolicited, never awaited, no id. */
    EVENT,
}

/**
 * The single envelope on the backend↔agent socket. See the "Wire protocol" section of
 * BOT_CONNECTIVITY.md.
 *
 * There is no destination field: the connection *is* the host, chosen by resolving `bot.hostId`, so
 * re-encoding it would create a second source of truth. [botId] routes within a host and is null for
 * host-scoped traffic such as heartbeats.
 *
 * [payload] stays a raw node on purpose. The envelope must parse without understanding the payload,
 * which is what lets an agent running a newer version send something this backend can still log,
 * correlate and ignore instead of failing the whole message.
 */
data class AgentEnvelope(
    val id: String? = null,
    val kind: MessageKind,
    val type: String,
    val botId: Long? = null,
    val ok: Boolean? = null,
    val payload: JsonNode? = null,
)

/** Commands the backend sends. */
object CommandType {
    const val SETUP_BOT = "setup_bot"
    const val CONNECT = "connect"
    const val DISCONNECT = "disconnect"
    const val CHAT = "chat"
    const val SET_CHAT_LISTENER = "set_chat_listener"
}

/** Events the backend understands. Anything else is logged and ignored, never fatal. */
object EventType {
    const val HEARTBEAT = "heartbeat"
    const val BOT_STATUS = "bot_status"
    const val SETUP_RESULT = "setup_result"
}

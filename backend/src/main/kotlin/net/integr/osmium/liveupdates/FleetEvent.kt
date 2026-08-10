package net.integr.osmium.liveupdates

/**
 * One thing that changed, on its way to the browser. See "Live updates to the frontend" in
 * FLEET_CONNECTIVITY.md.
 *
 * The browser channel is receive-only: commands travel over REST, where they are node-gated and
 * audited. This only says what changed.
 */
enum class FleetEventType(val eventName: String) {
    AGENT_CHANGED("agent"),
    AGENT_REMOVED("agent-removed"),
    HOST_CHANGED("host"),
    HOST_REMOVED("host-removed"),

    /**
     * Appended to a feed rather than replacing a resource. Both carry `agentId`, so the per-agent
     * stream gets them too - including the server's global chat, which arrives under whichever
     * agent currently forwards it. A client showing one agent's conversation filters on `scope`.
     */
    CHAT_MESSAGE("chat"),
    ACTIVITY_ENTRY("activity"),

    /**
     * An agent's vitals, on its own event rather than inside `agent`.
     *
     * Telemetry arrives every few seconds per agent while `agent` fires only when something
     * actually changes. Folding it in would turn a rare, meaningful event into a firehose, and send
     * the whole agent each time to carry a few numbers that moved.
     */
    AGENT_TELEMETRY("telemetry"),
}

/**
 * @param agentId set on agent events so the per-agent stream can filter without deserialising the
 *   payload, and so a removal still identifies its subject once the row is gone.
 * @param data the changed resource in the same shape the REST endpoints return, so a client can
 *   replace it in place rather than refetching.
 */
data class FleetEvent(
    val type: FleetEventType,
    val data: Any,
    val agentId: Long? = null,
)

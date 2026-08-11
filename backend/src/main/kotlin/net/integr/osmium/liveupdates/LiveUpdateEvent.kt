package net.integr.osmium.liveupdates

import net.integr.osmium.security.Nodes

/**
 * One thing that changed, on its way to the browser. See "Live updates to the frontend" in
 * FLEET_CONNECTIVITY.md.
 *
 * Not *fleet* events: the channel carries whatever a browser has to learn about without asking, and
 * hosts and agents are only what it carries today. Permission changes and the audit trail are the
 * obvious next ones, and neither is a fleet thing.
 *
 * The browser channel is receive-only: commands travel over REST, where they are node-gated and
 * audited. This only says what changed.
 *
 * @param eventName the SSE event name, which is the client's contract. Renaming a constant is free;
 *   renaming one of these is not.
 * @param node the permission a subscriber must hold to receive this kind of event. Declared on the
 *   type rather than passed at publish time because it belongs to the kind, not the occurrence —
 *   every `agent` event needs `fleet.read`, always — so a publisher cannot forget it or set it
 *   wrong.
 *
 *   **Nothing routes on it yet.** Every type below requires `fleet.read`, which is what the stream
 *   already checks once at subscribe and again on every tick, so dispatch consulting this would be
 *   a no-op today. `LiveUpdateTypeTest` pins that uniformity: the day a type arrives with a
 *   different node it fails, because at that moment the stream's single gate stops being
 *   sufficient and per-subscriber routing has to land with it.
 */
enum class LiveUpdateType(val eventName: String, val node: String) {
    AGENT_CHANGED("agent", Nodes.FLEET_READ),
    AGENT_REMOVED("agent-removed", Nodes.FLEET_READ),
    HOST_CHANGED("host", Nodes.FLEET_READ),
    HOST_REMOVED("host-removed", Nodes.FLEET_READ),

    /**
     * Appended to a feed rather than replacing a resource. Both carry `agentId`, so the per-agent
     * stream gets them too - including the server's global chat, which arrives under whichever
     * agent currently forwards it. A client showing one agent's conversation filters on `scope`.
     */
    CHAT_MESSAGE("chat", Nodes.FLEET_READ),
    ACTIVITY_ENTRY("activity", Nodes.FLEET_READ),

    /**
     * An agent's vitals, on its own event rather than inside `agent`.
     *
     * Telemetry arrives every few seconds per agent while `agent` fires only when something
     * actually changes. Folding it in would turn a rare, meaningful event into a firehose, and send
     * the whole agent each time to carry a few numbers that moved.
     */
    AGENT_TELEMETRY("telemetry", Nodes.FLEET_READ),
}

/**
 * @param agentId set on agent events so the per-agent stream can filter without deserialising the
 *   payload, and so a removal still identifies its subject once the row is gone.
 * @param data the changed resource in the same shape the REST endpoints return, so a client can
 *   replace it in place rather than refetching.
 */
data class LiveUpdateEvent(
    val type: LiveUpdateType,
    val data: Any,
    val agentId: Long? = null,
)

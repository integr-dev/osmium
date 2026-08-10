package net.integr.osmium.stream

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

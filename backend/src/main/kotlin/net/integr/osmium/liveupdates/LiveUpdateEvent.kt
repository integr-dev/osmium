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
 *   every `agent` event needs `agent.read`, always — so a publisher cannot forget it or set it
 *   wrong.
 *
 *   `LiveUpdateSubscriptions` checks it against the subscriber's own nodes on every dispatch, which
 *   is what lets one channel carry the audit trail and the fleet without the first leaking to
 *   everyone entitled to the second.
 */
enum class LiveUpdateType(val eventName: String, val node: String) {
    AGENT_CHANGED("agent", Nodes.AGENT_READ),
    AGENT_REMOVED("agent-removed", Nodes.AGENT_READ),
    HOST_CHANGED("host", Nodes.HOST_READ),
    HOST_REMOVED("host-removed", Nodes.HOST_READ),

    /**
     * Appended to a feed rather than replacing a resource. Both carry `agentId`, so the per-agent
     * stream gets them too - including the server's global chat, which arrives under whichever
     * agent currently forwards it. A client showing one agent's conversation filters on `scope`.
     */
    CHAT_MESSAGE("chat", Nodes.CHAT_READ),
    ACTIVITY_ENTRY("activity", Nodes.ACTIVITY_READ),

    /**
     * An agent's vitals, on its own event rather than inside `agent`.
     *
     * Telemetry arrives every few seconds per agent while `agent` fires only when something
     * actually changes. Folding it in would turn a rare, meaningful event into a firehose, and send
     * the whole agent each time to carry a few numbers that moved.
     */
    AGENT_TELEMETRY("telemetry", Nodes.AGENT_READ),

    USER_CHANGED("user", Nodes.USER_READ),
    USER_REMOVED("user-removed", Nodes.USER_READ),

    /**
     * The recipient's own permissions changed. Addressed to one account by [LiveUpdateEvent.username],
     * and gated on `user.read.self` because everyone may read their own.
     *
     * Authorities resolve from the database on every REST request, so the backend enforces a role
     * change immediately — but the browser learned what it may do once, at login. Without this it
     * keeps offering buttons that now fail, which reads as the app being broken rather than as
     * access having changed.
     */
    PERMISSIONS_CHANGED("permissions", Nodes.USER_READ_SELF),

    /**
     * One operator action, as it is recorded. The first event on this channel that most subscribers
     * must not receive — `audit.read` sits outside the `fleet.*` tier precisely so that running the
     * fleet does not entitle you to read what other operators did.
     */
    AUDIT_ENTRY("audit", Nodes.AUDIT_READ),

    /**
     * A schematic, as it arrives and then as it is read.
     *
     * The only event here that fires while nothing has changed in the world. A file of several
     * gigabytes takes minutes to upload and minutes more to read, and without this the interface
     * shows a row saying "analysing" with no way to tell a long job from a stuck one. Throttled
     * where it is produced rather than here, because the work underneath reports thousands of times
     * a second.
     */
    SCHEMATIC_CHANGED("schematic", Nodes.SCHEMATIC_READ),
    SCHEMATIC_REMOVED("schematic-removed", Nodes.SCHEMATIC_READ),
}

/**
 * @param data the changed resource in the same shape the REST endpoints return, so a client can
 *   replace it in place rather than refetching.
 * @param agentId set on agent events so the per-agent stream can filter without deserialising the
 *   payload, and so a removal still identifies its subject once the row is gone.
 * @param username when set, the event is **for that account and no other**.
 *
 *   Note this is the opposite default from [agentId], and the two must not be implemented alike.
 *   `agentId` is the subscriber narrowing itself — a per-agent stream asked for one agent, the
 *   fleet stream asked for all of them, so an event carrying an `agentId` still reaches the fleet
 *   stream. `username` is the event addressing one recipient, so a subscription that did not ask
 *   for anything in particular must still not receive it. Treating this like `agentId` would send
 *   every account's permissions to every open stream.
 */
data class LiveUpdateEvent(
    val type: LiveUpdateType,
    val data: Any,
    val agentId: Long? = null,
    val username: String? = null,
)

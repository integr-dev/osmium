package net.integr.osmium.hostlink

import com.fasterxml.jackson.annotation.JsonCreator
import com.fasterxml.jackson.annotation.JsonValue
import tools.jackson.databind.JsonNode
import net.integr.osmium.host.model.Host

/**
 * Separates the three message lifecycles. Declared rather than inferred from [HostEnvelope.type],
 * so a new message type does not have to be classified in code to be handled correctly.
 *
 * **Lowercase on the wire**, which is what the host documentation has always specified and what
 * Jackson would not have done on its own - it names enum constants as they are declared. The mock
 * host could never catch that, because it shares this very enum and so agreed with the backend
 * about a spelling neither of them was reading from the contract. The first real host disagreed
 * with both on its first frame.
 *
 * [wire] is the spelling; the constant names stay conventional for Kotlin.
 */
enum class MessageKind(@get:JsonValue val wire: String) {
    /** Backend to host. Carries an id and expects exactly one result. */
    COMMAND("command"),

    /** Host to backend. Echoes the command id it resolves. */
    RESULT("result"),

    /** Host to backend. Unsolicited, never awaited, no id. */
    EVENT("event");

    companion object {
        /**
         * Accepts either spelling. Lowercase is the contract, and the uppercase form is taken too
         * because this backend emitted it for as long as the mock host was the only thing reading
         * it - so a host written against what was observed rather than what was written down keeps
         * working.
         */
        @JvmStatic
        @JsonCreator
        fun from(value: String): MessageKind? =
            entries.firstOrNull { it.wire.equals(value, ignoreCase = true) }
    }
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

    /**
     * Start or stop streaming this agent's world: `{ "enabled": true }`.
     *
     * Demand-driven, and the only command that is. Following an agent means listening to every
     * block change and every entity movement in its view, so it runs only while somebody has the
     * screen open - [net.integr.osmium.viewer.ViewerConnections] turns it on for the first watcher
     * and off after the last.
     *
     * A host holds this in memory only, so one that reconnects is asked again for whatever still
     * has watchers rather than being expected to remember.
     */
    const val SET_VIEWER = "set_viewer"

    /**
     * Everything an operator has configured for this agent: `{ "values": { "chat.sender": "…" } }`.
     *
     * **The whole set, not a patch.** A key that is absent has been cleared, which is the only
     * reading under which a setting can be turned back off.
     *
     * The keys are declared by the interface and relayed uninterpreted, exactly like `setup_agent``s
     * `method`. A host ignores what it does not recognise, so an Osmium newer than a host is the
     * ordinary case rather than an error.
     *
     * Sent when it changes and again whenever the host reconnects, since a host holds this only in
     * memory and a restarted one would otherwise run on defaults.
     */
    const val SETTINGS = "settings"

    /**
     * Build this box.
     *
     * ```jsonc
     * { "jobId": 7, "segmentId": 31, "ticket": "9f2c…",
     *   "min": { "x": 128, "y": 64, "z": -340 },
     *   "max": { "x": 160, "y": 96, "z": -308 },
     *   "blocks": 20431 }
     * ```
     *
     * The box and the block count travel **as well as** being fetchable, so a host can size the
     * work, refuse one it cannot do and log something legible before it makes an HTTP call - and
     * so a progress report has a total to be measured against.
     *
     * The ticket rides along because it is minted by the very act this command announces. Making
     * a host ask for it separately would be a second round trip to learn something the backend
     * already knew when it decided to send this.
     *
     * Fire and forget, like [CONNECT]: the outcome arrives as a `build_progress` event, because
     * state advances when the host says so rather than when the backend asks.
     */
    const val BUILD_SEGMENT = "build_segment"

    /**
     * Stop building that box: `{ "segmentId": 31 }`.
     *
     * Sent when a segment is taken back and when its job is paused or deleted. Without it a host
     * goes on placing blocks nobody wants - a paused job that keeps building is the one outcome
     * pausing exists to prevent.
     *
     * Fire and forget, and **not** an error to receive for a segment already finished or never
     * started: it says stop, which is satisfied by having stopped.
     */
    const val CANCEL_SEGMENT = "cancel_segment"

    /**
     * Move what is in one inventory square onto another: `{ "from": 36, "to": 9 }`.
     *
     * Slot numbers are **Minecraft's own**, in the player window - 5-8 armour, 9-35 the backpack,
     * 36-44 the hotbar, 45 the off hand. Relayed rather than renumbered, because the host carries
     * this out as a click on a slot, and any renumbering in between is somewhere the screen and
     * the click can disagree about which square was pointed at.
     *
     * Fire and forget, like everything else here. Where the item ended up arrives on the next
     * [EventType.INVENTORY] - the same event that reports the agent moving something itself - so a
     * move the server refused reads as the item not having moved, which is what happened.
     */
    const val INVENTORY_MOVE = "inventory_move"

    /**
     * Throw what is in an inventory square on the ground: `{ "slot": 36, "count": 16 }`.
     *
     * An absent `count` means the whole stack, which is the ordinary case.
     */
    const val INVENTORY_DROP = "inventory_drop"

    /**
     * Put a hotbar square in the agent's hand: `{ "slot": 40 }`.
     *
     * The **square**, 36-44, not the 0-to-8 index the game keeps. Every command here names a square
     * the same way; the one index in this protocol is `held` on [EventType.INVENTORY], which is a
     * field the game itself defines as one, and the host translates between them.
     */
    const val INVENTORY_HOLD = "inventory_hold"

    /**
     * This agent is gone: `{}`, with the agent named on the envelope.
     *
     * A host binds each credential to the agent it was acquired for, so that a restart can rebuild
     * its agents instead of leaving them unreachable. Nothing else in the protocol ever says an
     * agent stopped existing - `handshake` reports what a host runs, never what the backend has
     * since deleted - so without this the binding outlives the agent and the account stays held for
     * something nobody can use.
     *
     * Fire and forget, **and best effort**: sent before the row goes, and a host that is unreachable
     * simply keeps the stale binding. Deleting an agent must not be refused because a machine is
     * switched off.
     *
     * Not an error for an agent the host has never heard of. It asks the host to hold nothing,
     * which holding nothing already satisfies.
     */
    const val DELETE_AGENT = "delete_agent"
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

    /**
     * How far through a segment an agent is:
     * `{ "segmentId": 31, "blocksPlaced": 12480, "state": "building" }`.
     *
     * `state` is `building`, `done` or `failed`, the last carrying a `reason` for the log. Sent
     * every few seconds while building, alongside the vitals in [AGENT_STATUS].
     *
     * **Last reported, never accumulated**, the same rule the vitals follow. A host that restarts
     * mid-segment resumes from what it can see, and adding up deltas would count those blocks
     * twice.
     *
     * Keyed by the segment rather than the agent. One agent holds one segment, so either would
     * identify it today - but the segment is the thing being built, and a late report about one
     * that has since been released is then ignorable rather than applied to whatever its agent
     * picked up next.
     */
    const val BUILD_PROGRESS = "build_progress"

    /**
     * One chunk of the world as an agent sees it from above:
     *
     * ```jsonc
     * { "x": 24, "z": -7, "dimension": "overworld",
     *   "palette": ["grass_block", "water"],
     *   "blocks":  "AAAAAQ…",   // base64, 256 bytes, one index into palette per block column
     *   "heights": "RgBGAA…" }  // base64, 256 signed 16-bit little-endian, -32768 for nothing
     * ```
     *
     * Coordinates are the **chunk's**, not the block's. Pixels are laid out row-major from the
     * north-west corner - west to east, then north to south - which is how a chunk is indexed
     * everywhere else in Minecraft.
     *
     * **Names, not colours.** Which colour a block reads as is a question about textures, and this
     * backend holds none: the interface drawing the map owns the palette, derived from the block
     * atlas the 3D view is already rendered from. Storing names is what keeps the two views
     * agreeing, and what lets a map be re-coloured without agents re-walking the world.
     *
     * `dimension` is the world without its `minecraft:` prefix, and is part of what identifies a
     * tile rather than a label on it - the dimensions are separate places sharing one coordinate
     * system. A host that omits it is taken to mean the overworld.
     *
     * Sent for the whole session rather than on demand, unlike the viewer stream - the map is worth
     * having drawn before anybody opens it. Filed against the agent's *server* and world, because a
     * map is about a place: every agent standing in one fills in the same map.
     */
    const val MAP_TILE = "map_tile"

    /**
     * What an agent is carrying:
     *
     * ```jsonc
     * { "slots": [ { "slot": 36, "name": "diamond_pickaxe", "displayName": "Diamond Pickaxe",
     *                "count": 1, "damage": 142, "maxDamage": 1561 } ],
     *   "held": 0 }
     * ```
     *
     * **Whole, not a patch.** An inventory is forty squares of a few bytes each, and a client that
     * assembled one out of deltas would have to be told when to throw its copy away - which is
     * every respawn, every dimension change and every reconnect. Occupied squares only: a square
     * that is not named is empty, which is what a client draws anyway.
     *
     * `damage` and `maxDamage` are present together or not at all. Absent means the item does not
     * wear out, which is a different thing from an undamaged tool.
     *
     * Sent when items move rather than on a tick, so an agent that has reported nothing for a
     * minute is standing still rather than gone - which is why it ages out more slowly than the
     * vitals do. See [net.integr.osmium.agent.service.AgentInventoryStore].
     */
    const val INVENTORY = "inventory"
}

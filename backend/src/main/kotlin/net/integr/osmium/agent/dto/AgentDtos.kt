package net.integr.osmium.agent.dto

import io.swagger.v3.oas.annotations.media.Schema
import tools.jackson.databind.ObjectMapper
// Jackson 3 moved databind to tools.jackson but left the annotations where they were.
import com.fasterxml.jackson.annotation.JsonProperty
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.host.model.Host
import java.time.Instant

@Schema(description = "Creates an agent slot. Nothing has touched Minecraft at this point.")
data class CreateAgentRequest(
    @field:NotBlank
    @field:Size(max = AGENT_LABEL_MAX_LENGTH)
    val label: String,

    val hostId: Long,

    /**
     * **Optional.** Requiring one here forced an operator to decide where an agent would play before
     * it had been set up, and therefore before they knew the credential worked. Assigning it later
     * through `PUT /api/agents/{id}/server` is the ordinary path; this exists so the common case
     * still takes one call.
     */
    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(description = "Where it should play, if that is already known.", example = "mc.example.com")
    val serverAddress: String? = null,
)

@Schema(
    description = "Points an agent at a Minecraft server, or at none. Separate from both setup and " +
        "editing: the account is the same account wherever it joins, so where it plays is its own " +
        "decision and changing it touches no credential.",
)
data class AssignServerRequest(
    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(
        description = "Null unassigns it, leaving the agent set up and idle.",
        example = "mc.example.com",
    )
    val serverAddress: String?,
)

@Schema(
    description = "What an operator has configured for an agent. The keys are the interface's own and " +
        "are relayed to the host uninterpreted; a host ignores any it does not recognise.",
)
data class AgentSettingsRequest(
    @field:Schema(description = "Every setting, not a patch. A key left out has been cleared.")
    val values: Map<String, String>?,
)

@Schema(description = "A player standing near an agent in game.")
data class NearbyPlayerResponse(
    val name: String,
    @field:Schema(description = "Blocks away.", example = "12.4")
    val distance: Double,
    /**
     * **Optional**, unlike the agent's own position, which is required with the rest of the vitals.
     *
     * The difference is what an absent value would claim. Missing vitals get defaulted into a
     * healthy agent standing at the origin, which is a lie; a nearby player without coordinates is
     * just a player whose coordinates were not reported, and the interface can say exactly that.
     * A host may know the distance without a usable position — an entity at the edge of the loaded
     * range, or a server that hides them — and dropping the whole entry over it would lose the one
     * fact that matters most, which is that somebody is there.
     */
    @field:Schema(description = "Where the player is, when the host reported it.")
    val position: PositionResponse?,

    /**
     * What the server told the host about them, and no more. Every field here is nullable, and an
     * absent one means the server said nothing rather than that the value is zero.
     */
    @field:Schema(description = "Their account, for drawing the right head. Null when unreported.")
    val uuid: String?,
    @field:Schema(description = "Round trip as the server measures it, in ms.", example = "84")
    val ping: Int?,
    @field:Schema(description = "0 survival, 1 creative, 2 adventure, 3 spectator.", example = "0")
    val gamemode: Int?,
    /**
     * Hit points on the game's own scale, where twenty is full.
     *
     * **This used to say health could not be known.** It can: health is a synced field on every
     * living entity, which is how a health-tag mod works with no server plugin behind it. What was
     * true is that mineflayer does not lift it out for anything but the bot itself, so the host
     * reads it from the entity metadata — by the name `minecraft-data` gives the key for that
     * version, never by a written-down index.
     *
     * A fraction, because half a heart is a real state and a player on 0.5 is one hit from dead.
     * Null when the server strips it, and for the moment after somebody comes into view and before
     * their first metadata packet arrives.
     */
    @field:Schema(description = "Hit points out of twenty. Null when the server did not say.", example = "18.5")
    val health: Double?,
    /**
     * Named explicitly because Kotlin's `is` prefix becomes a getter Jackson reads as the property
     * `agent`, which would put `nearby[].agent` on the wire and read as nonsense next to `name`.
     */
    @get:JsonProperty("isAgent")
    @field:Schema(
        description = "True when this is another agent in the fleet. Decided by Osmium, not by the " +
            "host: a host only sees its own agents, so it cannot tell one of ours from a stranger.",
    )
    val isAgent: Boolean,
)

@Schema(
    description = "An agent's latest reported vitals. Never stored - if an agent has not reported " +
        "recently this is null, rather than showing something an hour old as though it were now.",
)
data class AgentTelemetryResponse(
    @field:Schema(description = "Out of 20.", example = "18")
    val health: Int,
    @field:Schema(description = "Out of 20.", example = "17")
    val food: Int,
    val position: PositionResponse,
    @field:Schema(example = "overworld")
    val dimension: String,
    @field:Schema(description = "Round trip to the Minecraft server.", example = "42")
    val pingMs: Int,
    val nearby: List<NearbyPlayerResponse>,
)

@Schema(description = "A position in the world.")
data class PositionResponse(val x: Double, val y: Double, val z: Double)

@Schema(description = "An agent. Only its Minecraft identity is stored, never a credential.")
data class AgentResponse(
    val id: Long,
    val label: String,
    val hostId: Long,
    val hostName: String,
    @field:Schema(description = "Where it plays, or null when it is assigned nowhere and cannot connect.")
    val serverAddress: String?,
    @field:Schema(description = "Stored state, adjusted to STALE when the owning host is unreachable.")
    val state: AgentState,
    val mcUsername: String?,
    val mcUuid: String?,
    @param:Schema(description = "What the operator has configured, as the interface declared it.")
    val settings: Map<String, String>,

    @field:Schema(description = "When the agent last entered the game. Null while it is not online.")
    val onlineSince: Instant?,

    @field:Schema(description = "Latest vitals, or null when the agent has not reported recently.")
    val telemetry: AgentTelemetryResponse?,

    @field:Schema(
        description = "True when this agent forwards its server's global chat. One per server, " +
            "elected by the backend - a server with none has no global feed.",
    )
    val chatListener: Boolean,

    @field:Schema(
        description = "True while Osmium still intends to put this agent back in the game: it was " +
            "connected on purpose and is not online. Covers the wait between attempts as well as " +
            "an attempt in flight, so an interface can offer to stop trying. Cleared by a disconnect.",
    )
    val rejoining: Boolean,
)

@Schema(
    description = "Renames an agent. Where it plays is set through `PUT /api/agents/{id}/server`, " +
        "which is a different kind of change and has its own preconditions.",
)
data class UpdateAgentRequest(
    @field:Size(max = AGENT_LABEL_MAX_LENGTH)
    val label: String? = null,
)

@Schema(
    description = "Asks the host to set the agent up. The method is a mechanism the operator chose, " +
        "relayed to the host uninterpreted. It must never identify an account.",
)
data class SetupAgentRequest(
    @field:NotBlank
    @field:Size(max = SETUP_METHOD_MAX_LENGTH)
    @field:Schema(
        description = "One of the ids the owning host advertised in its handshake. Anything else " +
            "is refused, and a host that advertised nothing can set nothing up.",
        example = "device_code",
    )
    val method: String,
)

@Schema(description = "Sends a chat message as an agent. This is impersonation - gated on chat.")
data class ChatRequest(
    @field:NotBlank
    @field:Size(max = CHAT_MAX_LENGTH)
    val message: String,
)

/**
 * The live stream publishes this same shape, so a client can replace a resource in place rather than
 * refetching. Two mappers would let the two channels drift.
 *
 * [telemetry] has no default on purpose. It lives outside the entity, in
 * [net.integr.osmium.agent.service.AgentTelemetryStore], so a defaulted parameter would let a call
 * site quietly publish an agent with its vitals blanked - and on the live stream that reads as "this
 * agent stopped reporting" rather than as "this code path did not look them up".
 */
fun Agent.toResponse(telemetry: AgentTelemetryResponse?): AgentResponse = AgentResponse(
    id = checkNotNull(id) { "Agent has not been persisted yet" },
    label = label,
    hostId = checkNotNull(host.id) { "Host has not been persisted yet" },
    hostName = host.name,
    serverAddress = serverAddress,
    state = effectiveState(),
    mcUsername = mcUsername,
    mcUuid = mcUuid,
    settings = readSettings(settings),
    onlineSince = onlineSince,
    telemetry = telemetry,
    chatListener = chatListener,
    rejoining = wanted && effectiveState() != AgentState.ONLINE,
)

const val AGENT_LABEL_MAX_LENGTH = 64
const val SERVER_ADDRESS_MAX_LENGTH = 128
const val SETUP_METHOD_MAX_LENGTH = 32

/** Minecraft's own chat limit. */
const val CHAT_MAX_LENGTH = 256

/**
 * Reads an agent's stored configuration back into a map.
 *
 * Its own mapper rather than the injected one, because this is a free function and the alternative
 * is threading a mapper through every call site that turns an agent into a response. Nothing here is
 * configuration-sensitive: it reads JSON this backend itself wrote.
 *
 * A row that will not parse is served as unconfigured rather than failing the page. It should be
 * impossible — the column is only ever written from a serialised map — and an agent list that
 * returns nothing because one row is malformed would be a worse answer than one agent shown with no
 * settings.
 */
private val settingsReader = ObjectMapper()

private fun readSettings(stored: String?): Map<String, String> {
    if (stored.isNullOrBlank()) return emptyMap()

    return runCatching {
        @Suppress("UNCHECKED_CAST")
        settingsReader.readValue(stored, Map::class.java) as Map<String, String>
    }.getOrDefault(emptyMap())
}

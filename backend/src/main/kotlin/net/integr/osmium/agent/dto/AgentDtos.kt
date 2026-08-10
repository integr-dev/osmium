package net.integr.osmium.agent.dto

import io.swagger.v3.oas.annotations.media.Schema
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

    @field:NotBlank
    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(example = "mc.example.com:25565")
    val serverAddress: String,
)

@Schema(description = "A player standing near an agent in game.")
data class NearbyPlayerResponse(
    val name: String,
    @field:Schema(description = "Blocks away.", example = "12.4")
    val distance: Double,
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
    val serverAddress: String,
    @field:Schema(description = "Stored state, adjusted to STALE when the owning host is unreachable.")
    val state: AgentState,
    val mcUsername: String?,
    val mcUuid: String?,

    @field:Schema(description = "When the agent last entered the game. Null while it is not online.")
    val onlineSince: Instant?,

    @field:Schema(description = "Latest vitals, or null when the agent has not reported recently.")
    val telemetry: AgentTelemetryResponse?,

    @field:Schema(
        description = "True when this agent forwards its server's global chat. One per server, " +
            "elected by the backend - a server with none has no global feed.",
    )
    val chatListener: Boolean,
)

@Schema(
    description = "Edits an agent. Omitted fields are left alone. Moving an agent to another Minecraft " +
        "server does not affect its credentials - the account is the account, whichever server it " +
        "joins - but it must not be connected at the time.",
)
data class UpdateAgentRequest(
    @field:Size(max = AGENT_LABEL_MAX_LENGTH)
    val label: String? = null,

    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(description = "Move the agent to this server. Only while it is not online.")
    val serverAddress: String? = null,
)

@Schema(
    description = "Asks the host to set the agent up. The method is a mechanism the operator chose, " +
        "relayed to the host uninterpreted. It must never identify an account.",
)
data class SetupAgentRequest(
    @field:NotBlank
    @field:Size(max = SETUP_METHOD_MAX_LENGTH)
    @field:Schema(example = "method_a")
    val method: String,
)

@Schema(description = "Sends a chat message as an agent. This is impersonation - gated on fleet.chat.")
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
    onlineSince = onlineSince,
    telemetry = telemetry,
    chatListener = chatListener,
)

const val AGENT_LABEL_MAX_LENGTH = 64
const val SERVER_ADDRESS_MAX_LENGTH = 128
const val SETUP_METHOD_MAX_LENGTH = 32

/** Minecraft's own chat limit. */
const val CHAT_MAX_LENGTH = 256

package net.integr.osmium.agent.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.host.model.Host

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
 */
fun Agent.toResponse(): AgentResponse = AgentResponse(
    id = checkNotNull(id) { "Agent has not been persisted yet" },
    label = label,
    hostId = checkNotNull(host.id) { "Host has not been persisted yet" },
    hostName = host.name,
    serverAddress = serverAddress,
    state = effectiveState(),
    mcUsername = mcUsername,
    mcUuid = mcUuid,
    chatListener = chatListener,
)

const val AGENT_LABEL_MAX_LENGTH = 64
const val SERVER_ADDRESS_MAX_LENGTH = 128
const val SETUP_METHOD_MAX_LENGTH = 32

/** Minecraft's own chat limit. */
const val CHAT_MAX_LENGTH = 256

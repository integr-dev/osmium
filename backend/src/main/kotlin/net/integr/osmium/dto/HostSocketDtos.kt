package net.integr.osmium.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import net.integr.osmium.model.BotState
import java.time.Instant

@Schema(description = "Enrols an agent host. No address: the agent dials in, so its location is observed.")
data class CreateHostRequest(
    @field:NotBlank
    @field:Size(max = HOST_NAME_MAX_LENGTH)
    val name: String,
)

@Schema(description = "Renames a host. Everything else about a host is observed, not configured.")
data class UpdateHostRequest(
    @field:NotBlank
    @field:Size(max = HOST_NAME_MAX_LENGTH)
    val name: String,
)

@Schema(description = "An agent host. Reachability is derived from the heartbeat, not stored.")
data class HostResponse(
    val id: Long,
    val name: String,
    @field:Schema(description = "Observed when the agent connects. Null until it first dials in.")
    val address: String?,
    val agentVersion: String?,
    val lastSeenAt: Instant?,
    val reachable: Boolean,
    val botCount: Long,
)

@Schema(description = "A freshly enrolled host, with its enrolment token shown exactly once.")
data class HostEnrolledResponse(
    val host: HostResponse,
    @field:Schema(description = "Give this to the agent. It is hashed on the server and never shown again.")
    val token: String,
)

@Schema(description = "Creates a bot slot. Nothing has touched Minecraft at this point.")
data class CreateBotRequest(
    @field:NotBlank
    @field:Size(max = BOT_LABEL_MAX_LENGTH)
    val label: String,

    val hostId: Long,

    @field:NotBlank
    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(example = "mc.example.com:25565")
    val serverAddress: String,
)

@Schema(description = "A bot. Only its Minecraft identity is stored, never a credential.")
data class BotResponse(
    val id: Long,
    val label: String,
    val hostId: Long,
    val hostName: String,
    val serverAddress: String,
    @field:Schema(description = "Stored state, adjusted to STALE when the owning host is unreachable.")
    val state: BotState,
    val mcUsername: String?,
    val mcUuid: String?,
)

@Schema(
    description = "Edits a bot. Omitted fields are left alone. Moving a bot to another Minecraft " +
        "server does not affect its credentials - the account is the account, whichever server it " +
        "joins - but it must not be connected at the time.",
)
data class UpdateBotRequest(
    @field:Size(max = BOT_LABEL_MAX_LENGTH)
    val label: String? = null,

    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(description = "Move the bot to this server. Only while it is not online.")
    val serverAddress: String? = null,
)

@Schema(
    description = "Asks the host to set the bot up. The method is a mechanism the operator chose, " +
        "relayed to the host uninterpreted. It must never identify an account.",
)
data class SetupBotRequest(
    @field:NotBlank
    @field:Size(max = 32)
    @field:Schema(example = "device_code")
    val method: String,
)

@Schema(description = "Sends a chat message as a bot. This is impersonation - gated on agent.chat.")
data class ChatRequest(
    @field:NotBlank
    @field:Size(max = CHAT_MAX_LENGTH)
    val message: String,
)

const val HOST_NAME_MAX_LENGTH = 64
const val BOT_LABEL_MAX_LENGTH = 64
const val SERVER_ADDRESS_MAX_LENGTH = 128

/** Minecraft's own chat limit. */
const val CHAT_MAX_LENGTH = 256

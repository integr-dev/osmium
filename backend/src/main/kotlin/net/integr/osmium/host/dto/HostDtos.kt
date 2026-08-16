package net.integr.osmium.host.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import net.integr.osmium.host.model.Host
import java.time.Instant

@Schema(description = "Enrols a host. No address: the host dials in, so its location is observed.")
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

@Schema(
    description = "A login mechanism the host advertised in its handshake. The id is opaque to " +
        "the backend and is relayed to the host verbatim; the copy describes a mechanism, never " +
        "an account.",
)
data class LoginMethodResponse(
    @field:Schema(example = "device_code")
    val id: String,
    val label: String?,
    val description: String?,
)

@Schema(description = "A host. Reachability is derived from the heartbeat, not stored.")
data class HostResponse(
    val id: Long,
    val name: String,
    @field:Schema(description = "Observed when the host connects. Null until it first dials in.")
    val hostVersion: String?,
    val lastSeenAt: Instant?,
    val reachable: Boolean,
    val agentCount: Long,
    @field:Schema(
        description = "What this host can log in with, from its handshake. Empty while it is " +
            "disconnected, and empty for a host that advertises nothing - which can then set " +
            "nothing up.",
    )
    val loginMethods: List<LoginMethodResponse>,
)

@Schema(description = "A freshly enrolled host, with its enrolment token shown exactly once.")
data class HostEnrolledResponse(
    val host: HostResponse,
    @field:Schema(description = "Give this to the host. It is hashed on the server and never shown again.")
    val token: String,
)

/**
 * [agentCount] is passed in: it needs a query, which an entity mapper has no business doing.
 * [loginMethods] likewise - they live with the live connection, not on the row.
 */
fun Host.toResponse(
    agentCount: Long,
    loginMethods: List<LoginMethodResponse> = emptyList(),
): HostResponse = HostResponse(
    id = checkNotNull(id) { "Host has not been persisted yet" },
    name = name,
    hostVersion = hostVersion,
    lastSeenAt = lastSeenAt,
    reachable = isReachable(),
    agentCount = agentCount,
    loginMethods = loginMethods,
)

const val HOST_NAME_MAX_LENGTH = 64

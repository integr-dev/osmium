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

@Schema(description = "A host. Reachability is derived from the heartbeat, not stored.")
data class HostResponse(
    val id: Long,
    val name: String,
    @field:Schema(description = "Observed when the host connects. Null until it first dials in.")
    val address: String?,
    val hostVersion: String?,
    val lastSeenAt: Instant?,
    val reachable: Boolean,
    val agentCount: Long,
)

@Schema(description = "A freshly enrolled host, with its enrolment token shown exactly once.")
data class HostEnrolledResponse(
    val host: HostResponse,
    @field:Schema(description = "Give this to the host. It is hashed on the server and never shown again.")
    val token: String,
)

/** [agentCount] is passed in: it needs a query, which an entity mapper has no business doing. */
fun Host.toResponse(agentCount: Long): HostResponse = HostResponse(
    id = checkNotNull(id) { "Host has not been persisted yet" },
    name = name,
    address = address,
    hostVersion = hostVersion,
    lastSeenAt = lastSeenAt,
    reachable = isReachable(),
    agentCount = agentCount,
)

const val HOST_NAME_MAX_LENGTH = 64

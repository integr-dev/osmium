package net.integr.osmium.dto

import net.integr.osmium.model.Agent
import net.integr.osmium.model.Host
import net.integr.osmium.model.Role
import net.integr.osmium.model.User

fun User.toResponse(): UserResponse = UserResponse(
    id = checkNotNull(id) { "User has not been persisted yet" },
    username = username,
    role = role?.name,
    nodes = nodes().sorted(),
)

fun Role.toResponse(): RoleResponse = RoleResponse(
    id = checkNotNull(id) { "Role has not been persisted yet" },
    name = name,
    nodes = nodes.map { it.id }.sorted(),
)

/**
 * Shared rather than private to a service, because the live stream publishes exactly the shape the
 * REST endpoints return. Two mappers would let the two channels drift, and a client applying an
 * event in place would end up with a different object than a refetch produces.
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

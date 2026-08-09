package net.integr.osmium.dto

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

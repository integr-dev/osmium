package net.integr.osmium.account.dto

import io.swagger.v3.oas.annotations.media.Schema
import net.integr.osmium.account.model.Role

@Schema(description = "A role and the permission nodes it grants.")
data class RoleResponse(
    val id: Long,
    val name: String,
    val nodes: List<String>,
)

fun Role.toResponse(): RoleResponse = RoleResponse(
    id = checkNotNull(id) { "Role has not been persisted yet" },
    name = name,
    nodes = nodes.map { it.id }.sorted(),
)

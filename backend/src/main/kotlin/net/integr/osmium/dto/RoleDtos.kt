package net.integr.osmium.dto

import io.swagger.v3.oas.annotations.media.Schema

@Schema(description = "A role and the permission nodes it grants.")
data class RoleResponse(
    val id: Long,
    val name: String,
    val nodes: List<String>,
)

package net.integr.osmium.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.stream.StreamRegistry
import org.springframework.http.MediaType
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.security.core.Authentication
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter

/**
 * Receive-only live updates. Commands travel over REST, where they are node-gated and audited; this
 * only says what changed.
 *
 * Server-sent events rather than a second WebSocket: the traffic is genuinely one-way, reconnection
 * is part of the protocol rather than something to write, and there is no ping/pong or close-code
 * handling to maintain. See FLEET_CONNECTIVITY.md.
 */
@RestController
@RequestMapping("/api/stream")
@Tag(name = "Stream", description = "Server-sent events. Receive-only; commands go over REST.")
class StreamController(private val streamRegistry: StreamRegistry) {

    @GetMapping("/fleet", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    @PreAuthorize("hasAuthority('fleet.read')")
    @Operation(
        summary = "Stream every host and agent change.",
        description = "Events: `agent`, `agent-removed`, `host`, `host-removed`. Payloads match " +
            "the REST responses, so a client replaces the resource in place rather than refetching.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The stream."),
        ApiResponse(responseCode = "403", description = "Missing node `fleet.read`."),
    )
    fun fleet(authentication: Authentication): SseEmitter =
        streamRegistry.open(username = authentication.name, expiresAt = expiryOf(authentication))

    @GetMapping("/agents/{id}", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    @PreAuthorize("hasAuthority('fleet.read')")
    @Operation(summary = "Stream one agent's changes.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The stream."),
        ApiResponse(responseCode = "403", description = "Missing node `fleet.read`."),
    )
    fun agent(@PathVariable id: Long, authentication: Authentication): SseEmitter =
        streamRegistry.open(
            username = authentication.name,
            expiresAt = expiryOf(authentication),
            agentId = id,
        )

    /** A stream must not outlive the token that opened it; the registry enforces that from here. */
    private fun expiryOf(authentication: Authentication) =
        (authentication.principal as? Jwt)?.expiresAt
}

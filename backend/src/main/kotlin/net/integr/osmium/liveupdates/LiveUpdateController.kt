package net.integr.osmium.liveupdates

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.liveupdates.LiveUpdateSubscriptions
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
 *
 * **The door is deliberately wider than what comes through it.** Once the channel carries an
 * account's own permission changes, gating it on `fleet.read` would mean an account had to be
 * entitled to watch the fleet before it could be told its role had moved. `user.read.self` is what
 * every account holds and the least this can require; everything past that is decided per event
 * against the subscriber's own nodes, in `LiveUpdateSubscriptions`.
 */
@RestController
@RequestMapping("/api/stream")
@Tag(name = "Stream", description = "Server-sent events. Receive-only; commands go over REST.")
class LiveUpdateController(private val liveUpdates: LiveUpdateSubscriptions) {

    @GetMapping(produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    @PreAuthorize("hasAuthority('user.read.self')")
    @Operation(
        summary = "Stream everything this account is entitled to see change.",
        description = "Events: `agent`, `agent-removed`, `host`, `host-removed`, `chat`, " +
            "`activity`, `telemetry`, `user`, `user-removed`, `audit`, `permissions`. Resource " +
            "payloads match the REST responses, so a client replaces what it holds rather than " +
            "refetching; `chat`, `activity` and `audit` are single lines to append, and " +
            "`telemetry` is `{ agentId, telemetry }` to merge, published on a fixed tick rather " +
            "than per reported sample.\n\n" +
            "**Each event carries its own permission.** Opening the stream needs only " +
            "`user.read.self`, since every account has to be able to hear about itself; what " +
            "actually arrives is decided per event, so `agent` reaches only `fleet.read` and " +
            "`audit` only `audit.read`. `permissions` is " +
            "addressed to a single account when its own role changes and carries what " +
            "`/api/auth/me` returns. Authority is re-read on a 30s tick, so a demotion narrows an " +
            "open stream rather than needing a reconnect.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The stream."),
        ApiResponse(responseCode = "403", description = "Missing node `user.read.self`."),
    )
    fun stream(authentication: Authentication): SseEmitter =
        liveUpdates.open(username = authentication.name, expiresAt = expiryOf(authentication))

    @GetMapping("/agents/{id}", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    @PreAuthorize("hasAuthority('user.read.self')")
    @Operation(
        summary = "Stream one agent's changes.",
        description = "The same events as the whole stream, filtered to this agent. A server's " +
            "global chat arrives here too, under whichever agent currently forwards it, so a view " +
            "showing one agent's conversation filters on `scope`.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The stream."),
        ApiResponse(responseCode = "403", description = "Missing node `user.read.self`."),
    )
    fun agent(@PathVariable id: Long, authentication: Authentication): SseEmitter =
        liveUpdates.open(
            username = authentication.name,
            expiresAt = expiryOf(authentication),
            agentId = id,
        )

    /** A stream must not outlive the token that opened it; the registry enforces that from here. */
    private fun expiryOf(authentication: Authentication) =
        (authentication.principal as? Jwt)?.expiresAt
}

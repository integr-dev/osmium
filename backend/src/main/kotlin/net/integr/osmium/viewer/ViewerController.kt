package net.integr.osmium.viewer

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.agent.repository.AgentRepository
import org.springframework.http.HttpStatus
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException

/**
 * Mints the one-shot ticket a browser needs to open a viewer socket.
 *
 * The socket itself cannot be node checked - a browser cannot put a JWT on a WebSocket handshake -
 * so the check happens here, on an ordinary authenticated request, and the ticket stands in for it
 * exactly once. See [ViewerTickets].
 */
@RestController
@RequestMapping("/api/agents/{id}/viewer")
@Tag(name = "Viewer", description = "Watching an agent's world.")
class ViewerController(
    private val tickets: ViewerTickets,
    private val agents: AgentRepository,
) {

    data class TicketResponse(
        val ticket: String,
        /** What to offer as the first WebSocket subprotocol, with the ticket as the second. */
        val protocol: String,
        val expiresInSeconds: Long,
    )

    @PostMapping("/ticket")
    @PreAuthorize("hasAuthority('agent.view')")
    @Operation(
        summary = "Mint a one-shot ticket for this agent's viewer socket.",
        description = "Open `/ws/viewer` with `new WebSocket(url, ['osmium-viewer', ticket])`. The " +
            "ticket is single-use, expires in 30 seconds, and is good for this agent only. It goes " +
            "in the subprotocol rather than the query string so that it stays out of access logs " +
            "and browser history.\n\n" +
            "The socket carries binary frames only, and is receive-only: acting on an agent goes " +
            "over REST, where it is node checked and audited.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The ticket."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.view`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
    )
    fun ticket(@PathVariable id: Long, authentication: Authentication): TicketResponse {
        // Checked here rather than at the handshake: a ticket for an agent that does not exist
        // would otherwise be minted happily and fail as an authorization error a socket later.
        if (!agents.existsById(id)) throw ResponseStatusException(HttpStatus.NOT_FOUND, "No such agent")

        return TicketResponse(
            ticket = tickets.mint(authentication.name, id),
            protocol = ViewerHandshakeAuthenticator.PROTOCOL,
            expiresInSeconds = ViewerTickets.TTL.toSeconds(),
        )
    }
}

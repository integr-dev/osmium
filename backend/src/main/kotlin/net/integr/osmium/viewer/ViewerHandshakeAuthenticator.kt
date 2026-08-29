package net.integr.osmium.viewer

import org.springframework.http.HttpStatus
import org.springframework.http.server.ServerHttpRequest
import org.springframework.http.server.ServerHttpResponse
import org.springframework.stereotype.Component
import org.springframework.web.socket.WebSocketHandler
import org.springframework.web.socket.server.HandshakeInterceptor

/**
 * Authorises a browser's viewer socket during the handshake, before any frame is sent.
 *
 * A browser cannot set an `Authorization` header on a WebSocket, so the JWT never reaches here.
 * What does is a single-use ticket from [ViewerTickets], minted by a REST call that *was* node
 * checked, carried in `Sec-WebSocket-Protocol` - the one request header a browser can choose.
 *
 * The alternative, a ticket in the query string, is refused on purpose: URLs are written to access
 * logs, proxy logs and browser history, and a credential should not be in any of them.
 */
@Component
class ViewerHandshakeAuthenticator(private val tickets: ViewerTickets) : HandshakeInterceptor {

    override fun beforeHandshake(
        request: ServerHttpRequest,
        response: ServerHttpResponse,
        wsHandler: WebSocketHandler,
        attributes: MutableMap<String, Any>,
    ): Boolean {
        // `new WebSocket(url, [PROTOCOL, ticket])` arrives as one comma-separated header.
        val offered = request.headers[PROTOCOL_HEADER]
            .orEmpty()
            .flatMap { it.split(',') }
            .map { it.trim() }

        if (offered.firstOrNull() != PROTOCOL) return refuse(response)
        val ticket = offered.getOrNull(1) ?: return refuse(response)

        val spent = tickets.redeem(ticket) ?: return refuse(response)

        attributes[USERNAME] = spent.username
        attributes[AGENT_ID] = spent.agentId
        return true
    }

    /**
     * Aborting the handshake is not enough on its own: the status is the interceptor's to set, and
     * the servlet default of 200 otherwise stands on a socket that was refused.
     *
     * One status for every refusal - a missing header, the wrong protocol, and a ticket that is
     * forged, expired or already spent are the same answer. Separating them would only say which
     * half of a guess was right.
     */
    private fun refuse(response: ServerHttpResponse): Boolean {
        response.setStatusCode(HttpStatus.UNAUTHORIZED)
        return false
    }

    override fun afterHandshake(
        request: ServerHttpRequest,
        response: ServerHttpResponse,
        wsHandler: WebSocketHandler,
        exception: Exception?,
    ) = Unit

    companion object {
        const val USERNAME = "viewerUsername"
        const val AGENT_ID = "viewerAgentId"

        /** Named so the ticket beside it is never mistaken for the protocol itself. */
        const val PROTOCOL = "osmium-viewer"
        private const val PROTOCOL_HEADER = "Sec-WebSocket-Protocol"
    }
}

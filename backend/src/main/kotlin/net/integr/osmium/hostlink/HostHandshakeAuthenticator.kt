package net.integr.osmium.hostlink

import net.integr.osmium.host.service.HostService
import org.springframework.http.HttpHeaders
import org.springframework.http.server.ServerHttpRequest
import org.springframework.http.server.ServerHttpResponse
import org.springframework.stereotype.Component
import org.springframework.web.socket.WebSocketHandler
import org.springframework.web.socket.server.HandshakeInterceptor

/**
 * Authenticates a host during the WebSocket handshake, before any frame is accepted.
 *
 * Hosts are servers rather than browsers, so they can set an Authorization header - the limitation
 * that forces post-connect authentication for browser sockets does not apply here.
 */
@Component
class HostHandshakeAuthenticator(private val hostService: HostService) : HandshakeInterceptor {

    override fun beforeHandshake(
        request: ServerHttpRequest,
        response: ServerHttpResponse,
        wsHandler: WebSocketHandler,
        attributes: MutableMap<String, Any>,
    ): Boolean {
        val header = request.headers.getFirst(HttpHeaders.AUTHORIZATION) ?: return false
        if (!header.startsWith(BEARER)) return false

        val host = hostService.authenticate(header.removePrefix(BEARER)) ?: return false

        attributes[HOST_ID] = checkNotNull(host.id)
        attributes[HOST_NAME] = host.name
        // The observed address, which is why enrolment never asks for one.
        request.remoteAddress.let { attributes[REMOTE_ADDRESS] = "${it.hostString}:${it.port}" }
        return true
    }

    override fun afterHandshake(
        request: ServerHttpRequest,
        response: ServerHttpResponse,
        wsHandler: WebSocketHandler,
        exception: Exception?,
    ) = Unit

    companion object {
        const val HOST_ID = "hostId"
        const val HOST_NAME = "hostName"
        const val REMOTE_ADDRESS = "remoteAddress"
        private const val BEARER = "Bearer "
    }
}

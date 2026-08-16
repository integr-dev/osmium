package net.integr.osmium.hostlink

import net.integr.osmium.host.service.HostService
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
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
        val header = request.headers.getFirst(HttpHeaders.AUTHORIZATION) ?: return refuse(response)
        if (!header.startsWith(BEARER)) return refuse(response)

        val host = hostService.authenticate(header.removePrefix(BEARER)) ?: return refuse(response)

        attributes[HOST_ID] = checkNotNull(host.id)
        attributes[HOST_NAME] = host.name
        // The observed address, which is why enrolment never asks for one.
        request.remoteAddress.let { attributes[REMOTE_ADDRESS] = "${it.hostString}:${it.port}" }
        return true
    }

    /**
     * Returning false aborts the handshake, and nothing upgrades - but the status is the
     * interceptor's to set, and without this the servlet default of **200** stands. The socket was
     * still refused; the caller was simply told the opposite.
     *
     * That is worst exactly where it is most likely: rotate a host's token, forget to update the
     * host, and it reports success while never connecting. Anything watching from in front - a
     * proxy, an uptime check - reads 200 the same way. This chain is `permitAll` in
     * [net.integr.osmium.security.SecurityConfig] so that a host token reaches this class instead of
     * being rejected as a malformed JWT, which also means no filter is left to correct the status.
     *
     * One status for all three refusals. A missing header, the wrong scheme and a token that does
     * not authenticate are the same answer, and separating them would only tell a caller which half
     * of a guess was right.
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
        const val HOST_ID = "hostId"
        const val HOST_NAME = "hostName"
        const val REMOTE_ADDRESS = "remoteAddress"
        private const val BEARER = "Bearer "
    }
}

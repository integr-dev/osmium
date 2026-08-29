package net.integr.osmium.hostlink

import net.integr.osmium.hostlink.HostHandshakeAuthenticator
import net.integr.osmium.hostlink.HostMessageHandler
import net.integr.osmium.viewer.ViewerHandshakeAuthenticator
import net.integr.osmium.viewer.ViewerSocketHandler
import org.springframework.context.annotation.Configuration
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry

@Configuration
@EnableWebSocket
class HostLinkConfig(
    private val handler: HostMessageHandler,
    private val interceptor: HostHandshakeAuthenticator,
    private val viewerHandler: ViewerSocketHandler,
    private val viewerInterceptor: ViewerHandshakeAuthenticator,
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        // Hosts dial in here. Authentication happens in the handshake interceptor, not the Spring
        // Security filter chain, because a host token is not a JWT.
        registry.addHandler(handler, "/ws/host").addInterceptors(interceptor)

        // Browsers watching an agent's world. Authorised by a one-shot ticket in the subprotocol,
        // for the reason given on ViewerHandshakeAuthenticator: a browser cannot put a JWT on a
        // WebSocket handshake. The ticket is what authorises the socket, so it is what bounds who
        // may open one - not the origin.
        registry.addHandler(viewerHandler, "/ws/viewer").addInterceptors(viewerInterceptor)
    }

}

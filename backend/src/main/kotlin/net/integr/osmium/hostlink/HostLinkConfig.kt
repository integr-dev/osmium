package net.integr.osmium.hostlink

import net.integr.osmium.hostlink.HostHandshakeAuthenticator
import net.integr.osmium.hostlink.HostMessageHandler
import org.springframework.context.annotation.Configuration
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry

@Configuration
@EnableWebSocket
class HostLinkConfig(
    private val handler: HostMessageHandler,
    private val interceptor: HostHandshakeAuthenticator,
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        // Hosts dial in here. Authentication happens in the handshake interceptor, not the Spring
        // Security filter chain, because a host token is not a JWT.
        registry.addHandler(handler, "/ws/host").addInterceptors(interceptor)
    }
}

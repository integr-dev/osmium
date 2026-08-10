package net.integr.osmium.config

import net.integr.osmium.websocket.HostHandshakeInterceptor
import net.integr.osmium.websocket.HostWebSocketHandler
import org.springframework.context.annotation.Configuration
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry

@Configuration
@EnableWebSocket
class WebSocketConfig(
    private val handler: HostWebSocketHandler,
    private val interceptor: HostHandshakeInterceptor,
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        // Hosts dial in here. Authentication happens in the handshake interceptor, not the Spring
        // Security filter chain, because a host token is not a JWT.
        registry.addHandler(handler, "/ws/host").addInterceptors(interceptor)
    }
}

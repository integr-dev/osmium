package net.integr.osmium.config

import net.integr.osmium.websocket.AgentHandshakeInterceptor
import net.integr.osmium.websocket.AgentWebSocketHandler
import org.springframework.context.annotation.Configuration
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry

@Configuration
@EnableWebSocket
class WebSocketConfig(
    private val handler: AgentWebSocketHandler,
    private val interceptor: AgentHandshakeInterceptor,
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        // Agents dial in here. Authentication happens in the handshake interceptor, not the Spring
        // Security filter chain, because an agent token is not a JWT.
        registry.addHandler(handler, "/ws/agent").addInterceptors(interceptor)
    }
}

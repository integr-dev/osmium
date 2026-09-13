package net.integr.osmium.hostlink

import net.integr.osmium.hostlink.HostHandshakeAuthenticator
import net.integr.osmium.hostlink.HostMessageHandler
import net.integr.osmium.viewer.ViewerHandshakeAuthenticator
import net.integr.osmium.viewer.ViewerSocketHandler
import org.springframework.boot.tomcat.TomcatContextCustomizer
import org.springframework.context.annotation.Bean
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

    /**
     * How large one text frame from a host may be.
     *
     * **Tomcat's default is 8 KiB, and a route is bigger than that.** A walk searched 128 blocks out
     * is hundreds of nodes, each a few dozen bytes of JSON, and a frame over the limit closes the
     * socket with 1009 - so the host reconnected, restated the same route, and was closed again, once
     * a second, with every command in between refused as undeliverable.
     */
    //
    // Set on Tomcat's context rather than through `ServletServerContainerFactoryBean`, which needs a
    // running container to find - and so failed every test context, which has none.
    @Bean
    fun webSocketTextBuffer(): TomcatContextCustomizer = TomcatContextCustomizer { context ->
        context.addParameter(TEXT_BUFFER_PARAMETER, MAX_TEXT_FRAME_BYTES.toString())
    }

    private companion object {
        const val TEXT_BUFFER_PARAMETER = "org.apache.tomcat.websocket.textBufferSize"
        const val MAX_TEXT_FRAME_BYTES = 4 * 1024 * 1024
    }
}

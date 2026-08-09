package net.integr.osmium.websocket

import net.integr.osmium.service.AgentEventService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.TextWebSocketHandler
import tools.jackson.databind.ObjectMapper

@Component
class AgentWebSocketHandler(
    private val registry: AgentSessionRegistry,
    private val events: AgentEventService,
    private val objectMapper: ObjectMapper,
) : TextWebSocketHandler() {

    private val log = LoggerFactory.getLogger(javaClass)

    override fun afterConnectionEstablished(session: WebSocketSession) {
        val hostId = session.hostId() ?: return
        registry.register(hostId, session)
        events.onConnected(hostId, session.attributes[AgentHandshakeInterceptor.REMOTE_ADDRESS] as? String)
        log.info("Agent connected for host {}", session.attributes[AgentHandshakeInterceptor.HOST_NAME])
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        val hostId = session.hostId() ?: return
        registry.unregister(hostId, session)
        // Deliberately no state change on the bots: losing the agent does not tell us whether its
        // bots left the game, so they become STALE by derivation rather than being marked offline.
        log.info("Agent for host {} disconnected: {}", hostId, status)
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        val hostId = session.hostId() ?: return

        val envelope = try {
            objectMapper.readValue(message.payload, AgentEnvelope::class.java)
        } catch (failure: Exception) {
            // Unparseable input is the agent's problem, not grounds to drop a working connection.
            log.warn("Unparseable frame from host {}: {}", hostId, failure.message)
            return
        }

        try {
            events.onMessage(hostId, envelope)
        } catch (failure: Exception) {
            log.error("Failed handling {} from host {}", envelope.type, hostId, failure)
        }
    }

    private fun WebSocketSession.hostId(): Long? =
        attributes[AgentHandshakeInterceptor.HOST_ID] as? Long
}

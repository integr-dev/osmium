package net.integr.osmium.hostlink

import net.integr.osmium.hostlink.HostReportService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.TextWebSocketHandler
import tools.jackson.databind.ObjectMapper
import net.integr.osmium.host.model.Host

@Component
class HostMessageHandler(
    private val registry: HostConnections,
    private val events: HostReportService,
    private val objectMapper: ObjectMapper,
) : TextWebSocketHandler() {

    private val log = LoggerFactory.getLogger(javaClass)

    override fun afterConnectionEstablished(session: WebSocketSession) {
        val hostId = session.hostId() ?: return
        registry.register(hostId, session)
        events.onConnected(hostId, session.attributes[HostHandshakeAuthenticator.REMOTE_ADDRESS] as? String)
        log.info("Host {} connected", session.attributes[HostHandshakeAuthenticator.HOST_NAME])
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        val hostId = session.hostId() ?: return
        registry.unregister(hostId, session)
        // Deliberately no state change on the agents: losing the host does not tell us whether its
        // agents left the game, so they become STALE by derivation rather than being marked offline.
        log.info("Host {} disconnected: {}", hostId, status)
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        val hostId = session.hostId() ?: return

        val envelope = try {
            objectMapper.readValue(message.payload, HostEnvelope::class.java)
        } catch (failure: Exception) {
            // Unparseable input is the host's problem, not grounds to drop a working connection.
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
        attributes[HostHandshakeAuthenticator.HOST_ID] as? Long
}

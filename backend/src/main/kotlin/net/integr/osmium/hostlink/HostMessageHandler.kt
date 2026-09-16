package net.integr.osmium.hostlink

import net.integr.osmium.hostlink.HostReportService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import net.integr.osmium.viewer.ViewerConnections
import org.springframework.web.socket.BinaryMessage
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
    private val viewers: ViewerConnections,
    private val traffic: HostTraffic,
) : TextWebSocketHandler() {

    private val log = LoggerFactory.getLogger(javaClass)

    override fun afterConnectionEstablished(session: WebSocketSession) {
        val hostId = session.hostId() ?: return

        // The container defaults to 8 KB, and a gzipped chunk column is tens of them. Exceeding it
        // does not merely reject the frame, it fails the session - so without this the first world
        // a host streams would take its control socket down with it. Set per session rather than
        // on the container: a ServerContainer only exists under a real servlet container, and the
        // tests run without one.
        session.binaryMessageSizeLimit = FRAME_LIMIT
        registry.register(hostId, session)
        events.onConnected(hostId, session.attributes[HostHandshakeAuthenticator.REMOTE_ADDRESS] as? String)
        log.info("Host {} connected", session.attributes[HostHandshakeAuthenticator.HOST_NAME])
        // A host holds its viewer subscriptions in memory, so one that restarted is streaming
        // nothing while browsers sit on an open socket waiting for a world.
        viewers.resume(hostId)
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        val hostId = session.hostId() ?: return
        registry.unregister(hostId, session)
        // Deliberately no state change on the agents: losing the host does not tell us whether its
        // agents left the game, so they become STALE by derivation rather than being marked offline.
        log.info("Host {} disconnected: {}", hostId, status)
    }

    /**
     * World updates on their way to whoever is watching.
     *
     * Overridden because [TextWebSocketHandler] answers a binary frame by closing the connection,
     * so without this the first frame a host streams takes its control socket with it.
     *
     * Relayed, never read. The six-byte header names the agent and nothing here parses the body -
     * that is the renderer's business, and a JSON parse in front of every frame of every watched
     * agent would be the most expensive thing this backend does.
     */
    override fun handleBinaryMessage(session: WebSocketSession, message: BinaryMessage) {
        val hostId = session.hostId() ?: return
        traffic.received(hostId, message.payloadLength)
        val refused = viewers.relay(hostId, message.payload)
        // Either malformed, or about an agent this host was never asked to stream. Neither is
        // grounds to drop a working control socket, and both are worth knowing about.
        if (refused != null) log.warn("Dropped a viewer frame from host {}: {}", hostId, refused)
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        val hostId = session.hostId() ?: return
        traffic.received(hostId, message.payloadLength)

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

    private companion object {
        /** Comfortably past one gzipped chunk column, which is what the host bounds a frame to. */
        const val FRAME_LIMIT = 1024 * 1024
    }
}

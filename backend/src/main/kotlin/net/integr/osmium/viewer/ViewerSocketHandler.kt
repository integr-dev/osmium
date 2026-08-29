package net.integr.osmium.viewer

import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.SubProtocolCapable
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.AbstractWebSocketHandler

/**
 * A browser watching one agent's world.
 *
 * Receive-only, like the event stream and for the same reason: acting on an agent goes over REST,
 * where it is node checked and audited. Nothing a browser could send here would be read, so
 * anything it does send closes the socket rather than being ignored quietly - a client sending on
 * this is a client that has misunderstood what it is, and saying so is more use than silence.
 */
@Component
class ViewerSocketHandler(private val connections: ViewerConnections) : AbstractWebSocketHandler(), SubProtocolCapable {

    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * Agrees to the subprotocol the ticket rides in, and this is not optional.
     *
     * A browser that offered `Sec-WebSocket-Protocol` and gets no agreement back closes the
     * connection the instant it opens - abnormally, with no close frame and nothing said about why.
     * The handshake itself succeeds, so the server sees a watcher connect and vanish two
     * milliseconds later, which looks like anything except what it is.
     *
     * Only the name is offered. The ticket beside it is a credential, not a protocol, and echoing
     * it back would put it in a response header for no reason.
     */
    override fun getSubProtocols(): List<String> = listOf(ViewerHandshakeAuthenticator.PROTOCOL)

    override fun afterConnectionEstablished(session: WebSocketSession) {
        val agentId = session.agentId() ?: return
        connections.join(agentId, session)
        log.debug("{} is watching agent {}", session.attributes[ViewerHandshakeAuthenticator.USERNAME], agentId)
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        val agentId = session.agentId() ?: return
        connections.leave(agentId, session)
    }

    override fun handleTransportError(session: WebSocketSession, exception: Throwable) {
        // The close that follows removes it; this only keeps the failure out of the default logger,
        // which reports a browser navigating away as an error.
        log.debug("Viewer transport failed for agent {}", session.agentId(), exception)
    }

    private fun WebSocketSession.agentId(): Long? =
        attributes[ViewerHandshakeAuthenticator.AGENT_ID] as? Long
}

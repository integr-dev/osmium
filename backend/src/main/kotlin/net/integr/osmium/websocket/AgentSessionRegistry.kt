package net.integr.osmium.websocket

import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import tools.jackson.databind.ObjectMapper
import java.util.concurrent.ConcurrentHashMap

/**
 * Which hosts currently have a live agent connection, and the sole means of writing to them.
 *
 * One socket per host, multiplexing every bot that host owns. Kept behind this small interface so
 * that fanning out across several backend instances later becomes one implementation rather than a
 * rewrite - see the note on multiple instances in BOT_CONNECTIVITY.md.
 */
@Component
class AgentSessionRegistry(private val objectMapper: ObjectMapper) {

    private val log = LoggerFactory.getLogger(javaClass)
    private val sessions = ConcurrentHashMap<Long, WebSocketSession>()

    fun register(hostId: Long, session: WebSocketSession) {
        // A reconnect before the old socket was reaped would otherwise leave two live sessions.
        sessions.put(hostId, session)?.let { previous ->
            log.info("Host {} reconnected; closing the superseded session", hostId)
            runCatching { previous.close() }
        }
    }

    fun unregister(hostId: Long, session: WebSocketSession) {
        // Only drop it if it is still the session we know about, so a late close from a superseded
        // socket cannot evict the live one.
        sessions.remove(hostId, session)
    }

    fun isConnected(hostId: Long): Boolean = sessions[hostId]?.isOpen == true

    /**
     * Drops a host's connection. Used when its token is rotated: an already-authenticated session
     * would otherwise survive the rotation, which defeats the point if the old token leaked.
     */
    fun disconnect(hostId: Long) {
        sessions.remove(hostId)?.let { session ->
            log.info("Closing session for host {} after token rotation", hostId)
            runCatching { session.close() }
        }
    }

    /**
     * Writes one envelope to a host. Returns false when there is nothing to write to, which the
     * caller turns into an immediate failure - commands are never queued for later delivery.
     */
    fun send(hostId: Long, envelope: AgentEnvelope): Boolean {
        val session = sessions[hostId]?.takeIf { it.isOpen } ?: return false

        return try {
            // WebSocketSession is not thread safe, and REST requests dispatch concurrently.
            synchronized(session) { session.sendMessage(TextMessage(objectMapper.writeValueAsString(envelope))) }
            true
        } catch (failure: Exception) {
            log.warn("Failed writing {} to host {}", envelope.type, hostId, failure)
            false
        }
    }
}

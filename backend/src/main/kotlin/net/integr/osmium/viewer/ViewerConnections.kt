package net.integr.osmium.viewer

import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.MessageKind
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.socket.BinaryMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator
import tools.jackson.databind.ObjectMapper
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Who is watching which agent, and the only thing that relays a world to them.
 *
 * The stream is demand-driven from both ends. A host follows an agent's world only while this holds
 * a session for it, and stops the moment the last one goes away - following an agent means
 * listening to every block change and every entity movement in its view, which is not something to
 * leave running for a screen nobody has open.
 *
 * Frames are relayed, never read. What arrives from a host is bytes with a six-byte header naming
 * the agent; the header is all this looks at, and the body goes out exactly as it came in.
 */
@Component
class ViewerConnections(
    private val hosts: HostConnections,
    private val agents: AgentRepository,
    private val objectMapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    private val watchers = ConcurrentHashMap<Long, MutableSet<WebSocketSession>>()

    /**
     * Which host was asked to stream each agent.
     *
     * Recorded when the stream is turned on so an inbound frame can be checked against it without a
     * query per frame. A host may only send frames for agents it was told to stream: nothing else
     * stops one host claiming another's agent and having its world relayed to that agent's watchers.
     */
    private val streaming = ConcurrentHashMap<Long, Long>()

    /**
     * Wrapped before it is stored, and this is the difference between a viewer that works and one
     * that dies eighty milliseconds in.
     *
     * Frames are relayed on the *host's* read thread, so a plain `sendMessage` to a browser that
     * cannot keep up blocks the host - and when the write finally fails it takes the watcher with
     * it, as an unexplained 1006. The decorator gives each browser its own bounded buffer and a
     * send deadline: a slow one falls behind and is dropped on its own, and the host thread returns
     * immediately either way.
     *
     * A watcher that exceeds the buffer is dropped rather than served stale - the next frame of a
     * world is worth more than the last one, and a viewer that reconnects starts from a fresh fill.
     */
    @Transactional(readOnly = true)
    fun join(agentId: Long, session: WebSocketSession) {
        val sessions = watchers.computeIfAbsent(agentId) { ConcurrentHashMap.newKeySet() }
        val first = sessions.isEmpty()
        sessions += ConcurrentWebSocketSessionDecorator(session, SEND_TIME_LIMIT, BUFFER_LIMIT)

        if (first) start(agentId)
    }

    fun leave(agentId: Long, session: WebSocketSession) {
        val sessions = watchers[agentId] ?: return
        // Matched on id: what is stored is the decorator, not the session the container hands back.
        sessions.removeIf { it.id == session.id }
        if (sessions.isNotEmpty()) return

        // Removed under the same key it was added under, and only while still empty, so a watcher
        // arriving in between keeps the stream rather than having it stopped out from under it.
        watchers.remove(agentId, sessions)
        if (watchers[agentId] == null) stop(agentId)
    }

    /**
     * Relays one frame to everybody watching the agent it names.
     *
     * @return null when it was relayed, otherwise why it was not - the frame was unusable, or the
     *   host had no business sending it. A frame is never partially delivered: a session that fails
     *   is dropped and the rest still get it.
     */
    fun relay(hostId: Long, frame: ByteBuffer): String? {
        if (frame.remaining() < HEADER) return "frame is ${frame.remaining()} bytes, shorter than its header"

        val agentId = frame.getInt(frame.position() + AGENT_OFFSET).toLong() and UNSIGNED
        val asked = streaming[agentId]
        if (asked != hostId) return "agent $agentId is streamed by host $asked, not $hostId"

        val sessions = watchers[agentId] ?: return null
        for (session in sessions) {
            try {
                // WebSocketSession is not thread safe, and a host's frames arrive on its own thread
                // while this session may also be being closed from another.
                synchronized(session) { if (session.isOpen) session.sendMessage(BinaryMessage(frame.duplicate())) }
            } catch (failure: Exception) {
                // Warn, not debug: this ends somebody's screen, and the cause is never visible from
                // the browser - it sees a socket that closed for no stated reason.
                log.warn("Dropping a viewer watching agent {}", agentId, failure)
                sessions -= session
                runCatching { session.close() }
            }
        }
        return null
    }

    /** Whether anything is being streamed for this agent, for tests and for the health of the map. */
    fun watching(agentId: Long): Int = watchers[agentId]?.size ?: 0

    private fun start(agentId: Long) {
        val hostId = agents.findById(agentId).orElse(null)?.host?.id ?: return
        streaming[agentId] = hostId
        if (!send(hostId, agentId, enabled = true)) {
            // The host is not reachable. The subscription stands - a watcher is still watching, and
            // the host is told again when it comes back - but nothing will arrive until it does.
            log.debug("Agent {} is being watched but host {} is not connected", agentId, hostId)
        }
    }

    private fun stop(agentId: Long) {
        val hostId = streaming.remove(agentId) ?: return
        send(hostId, agentId, enabled = false)
    }

    /**
     * Re-asks for every stream that has watchers.
     *
     * A host holds this in memory only, so one that restarted is streaming nothing while browsers
     * sit on an open socket waiting. Called when a host reconnects.
     */
    fun resume(hostId: Long) {
        for ((agentId, owner) in streaming) {
            if (owner != hostId) continue
            if (watching(agentId) == 0) continue
            send(hostId, agentId, enabled = true)
        }
    }

    private fun send(hostId: Long, agentId: Long, enabled: Boolean): Boolean =
        hosts.send(
            hostId,
            HostEnvelope(
                id = "cmd-${UUID.randomUUID()}",
                kind = MessageKind.COMMAND,
                type = CommandType.SET_VIEWER,
                agentId = agentId,
                payload = objectMapper.valueToTree(mapOf("enabled" to enabled)),
            ),
        )

    private companion object {
        /** Frame version, flags, then the agent id. See the host's `viewer.ts`. */
        const val HEADER = 6
        const val AGENT_OFFSET = 2

        /** The id is written unsigned; Kotlin's `Int` is not. */
        const val UNSIGNED = 0xFFFFFFFFL

        /** How long a single write may take before the watcher is considered too slow to serve. */
        const val SEND_TIME_LIMIT = 10_000

        /** About one full view of columns in flight. Past this the browser is not keeping up. */
        const val BUFFER_LIMIT = 8 * 1024 * 1024
    }
}

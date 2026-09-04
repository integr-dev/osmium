package net.integr.osmium.hostlink

import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import tools.jackson.databind.ObjectMapper
import java.util.concurrent.ConcurrentHashMap
import net.integr.osmium.host.model.Host

/**
 * Which hosts currently have a live host connection, and the sole means of writing to them.
 *
 * One socket per host, multiplexing every agent that host owns. Kept behind this small interface so
 * that fanning out across several backend instances later becomes one implementation rather than a
 * rewrite - see the note on multiple instances in FLEET_CONNECTIVITY.md.
 */
@Component
class HostConnections(private val objectMapper: ObjectMapper) {

    private val log = LoggerFactory.getLogger(javaClass)
    private val sessions = ConcurrentHashMap<Long, WebSocketSession>()

    /**
     * What each connected host says it can log in with, from its handshake.
     *
     * Here rather than on the host row for the same reason reachability is derived: it is a claim
     * about a process that is running now. A stored list would outlive the build that made it and
     * have the backend offering an operator mechanisms the host has since dropped.
     */
    private val advertised = ConcurrentHashMap<Long, List<LoginMethod>>()

    /**
     * And what each says it can route a session through, from the same handshake.
     *
     * Kept the same way and for the same reason: a proxy is a file on a machine, and a list left
     * over from a build that has since been restarted would have an operator picking a route that
     * no longer exists. See [HostProxy].
     */
    private val routes = ConcurrentHashMap<Long, List<HostProxy>>()

    fun register(hostId: Long, session: WebSocketSession) {
        // A fresh socket has not said anything yet, and what the last one advertised was a claim
        // about a process that may since have been replaced by a different build.
        advertised.remove(hostId)
        routes.remove(hostId)

        // A reconnect before the old socket was reaped would otherwise leave two live sessions.
        sessions.put(hostId, session)?.let { previous ->
            log.info("Host {} reconnected; closing the superseded session", hostId)
            runCatching { previous.close() }
        }
    }

    fun unregister(hostId: Long, session: WebSocketSession) {
        // Only drop it if it is still the session we know about, so a late close from a superseded
        // socket cannot evict the live one - nor take the new one's advertisement with it.
        if (sessions.remove(hostId, session)) {
            advertised.remove(hostId)
            routes.remove(hostId)
        }
    }

    fun isConnected(hostId: Long): Boolean = sessions[hostId]?.isOpen == true

    fun advertise(hostId: Long, methods: List<LoginMethod>) {
        advertised[hostId] = methods
    }

    fun advertiseProxies(hostId: Long, proxies: List<HostProxy>) {
        routes[hostId] = proxies
    }

    /**
     * What this host can route through. Empty when it is not connected, which is the truthful
     * answer for the same reason the login methods are: nothing has told us, and an agent could not
     * be sent to it to try anyway.
     */
    fun proxiesOf(hostId: Long): List<HostProxy> =
        if (isConnected(hostId)) routes[hostId].orEmpty() else emptyList()

    /**
     * What this host can log in with. Empty when it is not connected, which is the truthful answer:
     * nothing has told us, and a command could not reach it to try anyway.
     */
    fun loginMethodsOf(hostId: Long): List<LoginMethod> =
        if (isConnected(hostId)) advertised[hostId].orEmpty() else emptyList()

    /**
     * Drops a host's connection. Used when its token is rotated: an already-authenticated session
     * would otherwise survive the rotation, which defeats the point if the old token leaked.
     */
    fun disconnect(hostId: Long) {
        advertised.remove(hostId)
        routes.remove(hostId)
        sessions.remove(hostId)?.let { session ->
            log.info("Closing session for host {} after token rotation", hostId)
            runCatching { session.close() }
        }
    }

    /**
     * Writes one envelope to a host. Returns false when there is nothing to write to, which the
     * caller turns into an immediate failure - commands are never queued for later delivery.
     */
    fun send(hostId: Long, envelope: HostEnvelope): Boolean {
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

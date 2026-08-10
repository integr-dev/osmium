package net.integr.osmium.chat.service

import net.integr.osmium.TestcontainersConfiguration
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.host.model.Host
import net.integr.osmium.host.repository.HostRepository
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostReportService
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.security.encodeRequired
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketHttpHeaders
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.client.standard.StandardWebSocketClient
import org.springframework.web.socket.handler.TextWebSocketHandler
import tools.jackson.databind.ObjectMapper
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Election over a real host socket, because the thing being tested is that a command actually
 * reaches a host - and the rule the service turns on is "told before recorded", which a stubbed
 * transport would let pass while it was broken.
 *
 * Deliberately not @Transactional, like `HostLinkTest`: the socket runs on other threads, so a
 * rolled-back test transaction would be invisible to it. The reconcile is invoked directly rather
 * than waited for, since its timer is measured in seconds.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestcontainersConfiguration::class)
class ChatListenerServiceTest {

    @LocalServerPort private var port: Int = 0

    @Autowired private lateinit var hostRepository: HostRepository
    @Autowired private lateinit var agentRepository: AgentRepository
    @Autowired private lateinit var passwordEncoder: PasswordEncoder
    @Autowired private lateinit var objectMapper: ObjectMapper
    @Autowired private lateinit var chatListeners: ChatListenerService
    @Autowired private lateinit var connections: HostConnections
    @Autowired private lateinit var hostReports: HostReportService

    private lateinit var host: Host
    private val secret = "s3cr3t-listener"

    @BeforeEach
    fun setUp() {
        cleanUp()
        host = hostRepository.saveAndFlush(
            Host(name = "host-listener", tokenHash = passwordEncoder.encodeRequired(secret)),
        )
    }

    @AfterEach
    fun cleanUp() {
        agentRepository.deleteAll()
        hostRepository.deleteAll()
    }

    private fun online(
        label: String,
        server: String = "mc.example.com:25565",
        onlineSince: Instant = Instant.now(),
        owner: Host = host,
    ) = agentRepository.saveAndFlush(
        Agent(
            label = label,
            host = owner,
            serverAddress = server,
            state = AgentState.ONLINE,
            onlineSince = onlineSince,
        ),
    )

    private fun reload(agent: Agent) = agentRepository.findById(checkNotNull(agent.id)).orElseThrow()

    // ---- electing ------------------------------------------------------------------------------

    /** Stability, not fairness: the session that has already proved it can hold a connection wins. */
    @Test
    fun `the longest running online agent is told to forward global chat`() {
        val now = Instant.now()
        val veteran = online("Mason_old", onlineSince = now.minusSeconds(600))
        val newcomer = online("Mason_new", onlineSince = now.minusSeconds(5))

        val socket = connectHost()
        chatListeners.reconcileAll()
        awaitUntil { socket.commands(CommandType.SET_CHAT_LISTENER).isNotEmpty() }

        val command = socket.commands(CommandType.SET_CHAT_LISTENER).single()
        assertEquals(veteran.id, command.agentId)
        assertTrue(command.payload?.get("enabled")?.asBoolean() == true)

        assertTrue(reload(veteran).chatListener)
        assertFalse(reload(newcomer).chatListener)

        socket.close()
    }

    /** A new agent joining must never take the role from one that is already forwarding correctly. */
    @Test
    fun `a working listener is not displaced by an agent that joins later`() {
        val incumbent = online("Mason_01", onlineSince = Instant.now().minusSeconds(600))
        val socket = connectHost()
        chatListeners.reconcileAll()
        awaitUntil { reload(incumbent).chatListener }

        online("Mason_02", onlineSince = Instant.now().minusSeconds(900))
        socket.received.clear()
        chatListeners.reconcileAll()

        assertTrue(reload(incumbent).chatListener)
        assertTrue(socket.commands(CommandType.SET_CHAT_LISTENER).isEmpty())

        socket.close()
    }

    /** Scope is the server, not the host: one listener each, from a single host's agents. */
    @Test
    fun `each server elects its own listener`() {
        val alpha = online("Mason_a", server = "alpha.example:25565")
        val beta = online("Mason_b", server = "beta.example:25565")

        val socket = connectHost()
        chatListeners.reconcileAll()
        awaitUntil { reload(alpha).chatListener && reload(beta).chatListener }

        val elected = socket.commands(CommandType.SET_CHAT_LISTENER).map { it.agentId }.toSet()
        assertEquals(setOf(alpha.id, beta.id), elected)

        socket.close()
    }

    /** Two hosts, one server: no host can see the other, which is why election is backend-side. */
    @Test
    fun `agents on one server share a listener across two hosts`() {
        val second = hostRepository.saveAndFlush(
            Host(name = "host-listener-2", tokenHash = passwordEncoder.encodeRequired(secret)),
        )
        online("Mason_h1", onlineSince = Instant.now().minusSeconds(600))
        online("Mason_h2", onlineSince = Instant.now().minusSeconds(900), owner = second)

        val first = connectHost(host)
        val other = connectHost(second)
        chatListeners.reconcileAll()
        awaitUntil { agentRepository.findAll().count { it.chatListener } == 1 }

        assertEquals(1, agentRepository.findAll().count { it.chatListener })
        assertEquals(
            1,
            first.commands(CommandType.SET_CHAT_LISTENER).size +
                other.commands(CommandType.SET_CHAT_LISTENER).size,
        )

        first.close()
        other.close()
    }

    // ---- losing the incumbent ------------------------------------------------------------------

    @Test
    fun `losing the incumbent hands the role to the next longest running agent`() {
        val incumbent = online("Mason_01", onlineSince = Instant.now().minusSeconds(600))
        val standby = online("Mason_02", onlineSince = Instant.now().minusSeconds(300))

        val socket = connectHost()
        chatListeners.reconcileAll()
        awaitUntil { reload(incumbent).chatListener }

        // The incumbent left the game but still holds the role, which is the state the sweep has to
        // resolve: stand the old one down, hand the role on, and record only what was delivered.
        agentRepository.saveAndFlush(reload(incumbent).apply { state = AgentState.LINKED })
        socket.received.clear()
        chatListeners.reconcileAll()

        assertTrue(reload(standby).chatListener)
        assertFalse(reload(incumbent).chatListener)

        val commands = socket.commands(CommandType.SET_CHAT_LISTENER).associateBy { it.agentId }
        assertEquals(true, commands[standby.id]?.payload?.get("enabled")?.asBoolean())
        assertEquals(false, commands[incumbent.id]?.payload?.get("enabled")?.asBoolean())

        socket.close()
    }

    /**
     * The failure that produces no event at all: STALE is derived from the heartbeat at read time,
     * so a host going silent changes nothing in the database. Without the sweep, a dead listener
     * would hold the role indefinitely and the server's chat would simply stop.
     */
    @Test
    fun `an unreachable host loses the role even though nothing reported it`() {
        val incumbent = online("Mason_01")
        val socket = connectHost()
        chatListeners.reconcileAll()
        awaitUntil { reload(incumbent).chatListener }

        socket.close()
        awaitUntil { !connections.isConnected(checkNotNull(host.id)) }
        chatListeners.reconcileAll()

        assertFalse(reload(incumbent).chatListener)
    }

    /** Honest rather than tidy: nothing is listening, so the server has no global feed. */
    @Test
    fun `a server with nothing online has no listener`() {
        val offline = agentRepository.saveAndFlush(
            Agent(label = "Mason_off", host = host, serverAddress = "mc.example.com:25565", state = AgentState.LINKED),
        )

        val socket = connectHost()
        chatListeners.reconcileAll()

        assertFalse(reload(offline).chatListener)
        assertTrue(socket.commands(CommandType.SET_CHAT_LISTENER).isEmpty())

        socket.close()
    }

    /**
     * Told before recorded. A listener recorded without the command landing leaves a server with one
     * on paper and silence in practice, which is the one failure an operator cannot see.
     */
    @Test
    fun `an agent whose host has no live socket is never recorded as the listener`() {
        val agent = online("Mason_01")

        chatListeners.reconcileAll()

        assertFalse(reload(agent).chatListener)
    }

    // ---- session length ------------------------------------------------------------------------

    /** A reconnect starts a new session, so an agent that keeps dropping cannot out-rank a stable one. */
    @Test
    fun `the session clock starts when the host reports the agent online and stops when it leaves`() {
        val agent = agentRepository.saveAndFlush(
            Agent(label = "Mason_01", host = host, serverAddress = "mc.example.com:25565", state = AgentState.LINKED),
        )
        assertNull(agent.onlineSince)

        reportState(agent, AgentState.ONLINE)
        val running = reload(agent)
        assertTrue(running.onlineSince != null)

        reportState(agent, AgentState.LINKED)
        assertNull(reload(agent).onlineSince)
    }

    /** An agent that left the game has stopped forwarding, so the next sweep sees a vacancy. */
    @Test
    fun `a reported disconnect gives up the role without waiting for the sweep`() {
        val agent = online("Mason_01")
        val socket = connectHost()
        chatListeners.reconcileAll()
        awaitUntil { reload(agent).chatListener }

        reportState(agent, AgentState.LINKED)

        assertFalse(reload(agent).chatListener)
        socket.close()
    }

    private fun reportState(agent: Agent, state: AgentState) = hostReports.onMessage(
        checkNotNull(host.id),
        HostEnvelope(
            kind = MessageKind.EVENT,
            type = EventType.AGENT_STATUS,
            agentId = agent.id,
            payload = objectMapper.valueToTree(mapOf("state" to state.name)),
        ),
    )

    // ---- harness -------------------------------------------------------------------------------

    private fun connectHost(owner: Host = host): ProbeHost {
        val headers = WebSocketHttpHeaders().apply {
            add(HttpHeaders.AUTHORIZATION, "Bearer osm_host_${owner.id}_$secret")
        }
        val probe = ProbeHost(objectMapper)
        probe.session = StandardWebSocketClient()
            .execute(probe, headers, java.net.URI("ws://localhost:$port/ws/host"))
            .get(5, java.util.concurrent.TimeUnit.SECONDS)

        // Two separate things become true in the connect callback, and eligibility needs both: the
        // socket is registered first, and the heartbeat that makes the host *reachable* is written
        // immediately after. Waiting only for the socket elects nothing, because every agent still
        // derives as STALE for that moment.
        awaitUntil {
            connections.isConnected(checkNotNull(owner.id)) &&
                hostRepository.findById(checkNotNull(owner.id)).orElseThrow().isReachable()
        }
        return probe
    }

    private fun awaitUntil(timeout: Duration = Duration.ofSeconds(5), condition: () -> Boolean) {
        val deadline = Instant.now().plus(timeout)
        while (Instant.now().isBefore(deadline)) {
            if (runCatching(condition).getOrDefault(false)) return
            Thread.sleep(100)
        }
        throw AssertionError("condition not met within $timeout")
    }

    private class ProbeHost(private val objectMapper: ObjectMapper) : TextWebSocketHandler() {
        lateinit var session: WebSocketSession
        val received = CopyOnWriteArrayList<HostEnvelope>()

        override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
            received += objectMapper.readValue(message.payload, HostEnvelope::class.java)
        }

        fun commands(type: String) = received.filter { it.type == type }

        fun close() = runCatching { session.close(CloseStatus.NORMAL) }
    }
}

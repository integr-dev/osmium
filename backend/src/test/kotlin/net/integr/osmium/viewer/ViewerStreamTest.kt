package net.integr.osmium.viewer

import net.integr.osmium.TestcontainersConfiguration
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.host.model.Host
import net.integr.osmium.host.repository.HostRepository
import net.integr.osmium.security.encodeRequired
import org.springframework.security.crypto.password.PasswordEncoder
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.HostEnvelope
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.web.socket.BinaryMessage
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.WebSocketHttpHeaders
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.client.standard.StandardWebSocketClient
import org.springframework.web.socket.handler.AbstractWebSocketHandler
import org.springframework.web.socket.handler.TextWebSocketHandler
import tools.jackson.databind.ObjectMapper
import java.net.URI
import java.nio.ByteBuffer
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * The viewer stream end to end, over real sockets: a host streams a frame and a browser watching
 * that agent receives it, byte for byte.
 *
 * Written because the interesting failures all live between the two and none of them is visible to
 * a unit test - a frame larger than the container's default buffer, a relay that drops the session
 * it could not write to, and a `set_viewer` that never goes out because nobody is watching yet.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestcontainersConfiguration::class)
class ViewerStreamTest {

    @Autowired private lateinit var hostRepository: HostRepository
    @Autowired private lateinit var agentRepository: AgentRepository
    @Autowired private lateinit var tickets: ViewerTickets
    @Autowired private lateinit var objectMapper: ObjectMapper
    @Autowired private lateinit var passwordEncoder: PasswordEncoder

    @LocalServerPort private var port: Int = 0

    private lateinit var host: Host
    private lateinit var agent: Agent
    private val opened = CopyOnWriteArrayList<WebSocketSession>()
    private val secret = "s3cr3t-viewer"

    @BeforeEach
    fun setUp() {
        host = hostRepository.saveAndFlush(
            Host(
                name = "viewer-host",
                tokenHash = passwordEncoder.encodeRequired(secret),
                lastSeenAt = Instant.now(),
                address = "10.0.0.1:1",
            ),
        )
        agent = agentRepository.saveAndFlush(
            Agent(label = "watched", host = host, serverAddress = "mc.example.com", state = AgentState.ONLINE),
        )
    }

    @AfterEach
    fun tearDown() {
        opened.forEach { runCatching { it.close(CloseStatus.NORMAL) } }
        opened.clear()
        agentRepository.deleteAll()
        hostRepository.deleteAll()
    }

    @Test
    fun `a frame from the host reaches the browser watching that agent`() {
        val hostProbe = connectHost()
        val watcher = watch()

        // The command only goes out once somebody is watching, which is the whole point of it.
        awaitUntil { hostProbe.commands(CommandType.SET_VIEWER, agent.id).isNotEmpty() }
        val command = hostProbe.commands(CommandType.SET_VIEWER, agent.id).first()
        assertEquals(true, command.payload?.get("enabled")?.asBoolean())

        val frame = frame(agent.id!!, body = ByteArray(64) { it.toByte() })
        hostProbe.stream(frame)

        awaitUntil { watcher.received.isNotEmpty() }
        assertArrayEquals(frame, watcher.received.single())
    }

    @Test
    fun `a frame the size of a chunk column survives, which the 8 KB default would not`() {
        val hostProbe = connectHost()
        val watcher = watch()
        awaitUntil { hostProbe.commands(CommandType.SET_VIEWER, agent.id).isNotEmpty() }

        // A gzipped column is tens of kilobytes. This is the failure the per-session limit exists
        // for, and it does not merely drop the frame - it fails the session.
        val frame = frame(agent.id!!, body = ByteArray(200_000) { (it % 251).toByte() })
        hostProbe.stream(frame)

        awaitUntil(Duration.ofSeconds(10)) { watcher.received.isNotEmpty() }
        assertArrayEquals(frame, watcher.received.single())
        assertTrue(watcher.session.isOpen, "the watcher's socket must survive a full-size frame")
    }

    @Test
    fun `the host is told to stop once the last watcher goes`() {
        val hostProbe = connectHost()
        val watcher = watch()
        awaitUntil { hostProbe.commands(CommandType.SET_VIEWER, agent.id).isNotEmpty() }

        watcher.session.close(CloseStatus.NORMAL)

        awaitUntil { hostProbe.commands(CommandType.SET_VIEWER, agent.id).size >= 2 }
        val last = hostProbe.commands(CommandType.SET_VIEWER, agent.id).last()
        assertEquals(false, last.payload?.get("enabled")?.asBoolean())
    }

    @Test
    fun `a host may not stream an agent it was never asked to stream`() {
        val hostProbe = connectHost()
        val watcher = watch()
        awaitUntil { hostProbe.commands(CommandType.SET_VIEWER, agent.id).isNotEmpty() }

        // Nothing else stops one host having another's world relayed to that agent's watchers.
        hostProbe.stream(frame(agent.id!! + 5_000, body = ByteArray(8)))
        hostProbe.stream(frame(agent.id!!, body = ByteArray(8) { 7 }))

        awaitUntil { watcher.received.isNotEmpty() }
        assertEquals(1, watcher.received.size, "only the agent this host was asked for may be relayed")
    }

    @Test
    fun `the server agrees to the subprotocol the ticket rode in on`() {
        // A browser that offers a subprotocol and is given no agreement closes the connection the
        // moment it opens - abnormally, saying nothing. This client tolerates the omission, which is
        // exactly why it has to be asserted rather than left to the other tests to notice.
        assertEquals(ViewerHandshakeAuthenticator.PROTOCOL, watch().session.acceptedProtocol)
    }

    @Test
    fun `a socket offering no ticket is refused`() {
        val failure = runCatching {
            StandardWebSocketClient()
                .execute(Watcher(), WebSocketHttpHeaders(), URI("ws://localhost:$port/ws/viewer"))
                .get(5, TimeUnit.SECONDS)
        }
        assertTrue(failure.isFailure, "a viewer socket must not open without a ticket")
    }

    @Test
    fun `a ticket is refused the second time`() {
        val ticket = tickets.mint("ada", agent.id!!)
        open(ticket)

        val replay = runCatching { open(ticket) }
        assertTrue(replay.isFailure, "a spent ticket must not open a second socket")
    }

    /** Mirrors the host's `frame()`: version, flags, agent id, then the body. */
    private fun frame(agentId: Long, body: ByteArray): ByteArray {
        val buffer = ByteBuffer.allocate(6 + body.size)
        buffer.put(1)
        buffer.put(0)
        buffer.putInt(agentId.toInt())
        buffer.put(body)
        return buffer.array()
    }

    private fun watch(): Watcher = open(tickets.mint("ada", agent.id!!))

    private fun open(ticket: String): Watcher {
        val watcher = Watcher()
        // The ticket rides the subprotocol, which is the one request header a browser can choose.
        val headers = WebSocketHttpHeaders().apply {
            add("Sec-WebSocket-Protocol", "${ViewerHandshakeAuthenticator.PROTOCOL},$ticket")
        }
        watcher.session = StandardWebSocketClient()
            .execute(watcher, headers, URI("ws://localhost:$port/ws/viewer"))
            .get(5, TimeUnit.SECONDS)
        opened += watcher.session
        return watcher
    }

    private fun connectHost(): HostProbe {
        val probe = HostProbe(objectMapper)
        // Read before `apply`: inside it, `host` resolves to HttpHeaders' own `host` property.
        val token = "Bearer osm_host_${host.id}_$secret"
        val headers = WebSocketHttpHeaders().apply { add(HttpHeaders.AUTHORIZATION, token) }
        probe.session = StandardWebSocketClient()
            .execute(probe, headers, URI("ws://localhost:$port/ws/host"))
            .get(5, TimeUnit.SECONDS)
        opened += probe.session
        return probe
    }

    private fun awaitUntil(timeout: Duration = Duration.ofSeconds(5), condition: () -> Boolean) {
        val deadline = Instant.now().plus(timeout)
        while (Instant.now().isBefore(deadline)) {
            if (runCatching(condition).getOrDefault(false)) return
            Thread.sleep(50)
        }
        throw AssertionError("condition not met within $timeout")
    }

    private class Watcher : AbstractWebSocketHandler() {
        lateinit var session: WebSocketSession
        val received = CopyOnWriteArrayList<ByteArray>()

        /**
         * A browser imposes no ceiling on an inbound binary message; this Java client defaults to
         * 8 KB. Raised so the stand-in behaves like the thing it stands in for - otherwise a chunk
         * column would fail here and pass in the product.
         */
        override fun afterConnectionEstablished(session: WebSocketSession) {
            session.binaryMessageSizeLimit = 1024 * 1024
        }

        override fun handleBinaryMessage(session: WebSocketSession, message: BinaryMessage) {
            received += ByteArray(message.payload.remaining()).also { message.payload.get(it) }
        }
    }

    private class HostProbe(private val objectMapper: ObjectMapper) : TextWebSocketHandler() {
        lateinit var session: WebSocketSession
        val received = CopyOnWriteArrayList<HostEnvelope>()

        override fun handleTextMessage(session: WebSocketSession, message: org.springframework.web.socket.TextMessage) {
            received += objectMapper.readValue(message.payload, HostEnvelope::class.java)
        }

        fun commands(type: String) = received.filter { it.type == type }

        /** Scoped to one agent: the registry is a singleton, so a sibling test in the same context
         * can have a command for its own agent in flight on this same socket. */
        fun commands(type: String, agentId: Long?) = commands(type).filter { it.agentId == agentId }

        fun stream(frame: ByteArray) = session.sendMessage(BinaryMessage(ByteBuffer.wrap(frame)))
    }
}

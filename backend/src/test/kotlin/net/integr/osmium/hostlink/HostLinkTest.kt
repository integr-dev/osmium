package net.integr.osmium.hostlink

import net.integr.osmium.TestcontainersConfiguration
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.host.model.Host
import net.integr.osmium.account.model.User
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.host.repository.HostRepository
import net.integr.osmium.account.repository.RoleRepository
import net.integr.osmium.account.repository.UserRepository
import net.integr.osmium.security.RoleNames
import net.integr.osmium.security.encodeRequired
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.web.client.RestClient
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
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.EventType

/**
 * End-to-end over a real WebSocket: a host authenticates with its enrolment token, heartbeats,
 * receives a command and answers it.
 *
 * Deliberately not @Transactional. The host runs on other threads, so a rolled-back test
 * transaction would be invisible to it; state is committed and cleaned up explicitly instead.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestcontainersConfiguration::class)
class HostLinkTest {

    @LocalServerPort private var port: Int = 0

    @Autowired private lateinit var hostRepository: HostRepository
    @Autowired private lateinit var agentRepository: AgentRepository
    @Autowired private lateinit var userRepository: UserRepository
    @Autowired private lateinit var roleRepository: RoleRepository
    @Autowired private lateinit var passwordEncoder: PasswordEncoder
    @Autowired private lateinit var objectMapper: ObjectMapper

    private lateinit var host: Host
    private lateinit var agent: Agent
    private lateinit var jwt: String
    private val secret = "s3cr3t-probe"

    @BeforeEach
    fun setUp() {
        cleanUp()

        host = hostRepository.saveAndFlush(
            Host(name = "host-probe", tokenHash = passwordEncoder.encodeRequired(secret)),
        )
        agent = agentRepository.saveAndFlush(
            Agent(
                label = "Probe_01",
                host = host,
                serverAddress = "mc.example.com:25565",
                state = AgentState.UNLINKED,
            ),
        )
        userRepository.saveAndFlush(
            User(
                username = "ws-operator",
                passwordHash = passwordEncoder.encodeRequired("correct-horse"),
                role = roleRepository.findByName(RoleNames.ADMINISTRATOR),
            ),
        )
        jwt = login("ws-operator", "correct-horse")
    }

    @AfterEach
    fun cleanUp() {
        agentRepository.deleteAll()
        hostRepository.deleteAll()
        userRepository.findByUsername("ws-operator")?.let { userRepository.delete(it) }
    }

    @Test
    fun `a host authenticates with its token, and its heartbeat makes the host reachable`() {
        assertFalse(hostRepository.findById(host.id!!).orElseThrow().isReachable())

        val socket = connect(token())
        socket.send(
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.HEARTBEAT,
                payload = objectMapper.valueToTree(mapOf("hostVersion" to "0.9.9-probe")),
            ),
        )

        awaitUntil { hostRepository.findById(host.id!!).orElseThrow().isReachable() }

        val refreshed = hostRepository.findById(host.id!!).orElseThrow()
        assertEquals("0.9.9-probe", refreshed.hostVersion)
        // Observed on connect, which is why enrolment never asks for one. Recorded on the host
        // and deliberately absent from HostResponse — see HostDtos.
        assertTrue(refreshed.address != null)

        socket.close()
    }

    @Test
    fun `a wrong token is refused at the handshake`() {
        val failure = runCatching { connect("osm_host_${host.id}_wrong") }
        assertTrue(failure.isFailure, "the handshake should have been rejected")
    }

    /**
     * The refusal above only proves nothing upgraded — a client-side failure looks the same whatever
     * the server answered, which is how these three shipped as **200**. The status is asserted
     * directly instead, because a host told "OK" by a socket that never opens has nothing to go on.
     */
    @Test
    fun `a handshake with no credentials answers 401`() {
        assertEquals(401, handshake(null).statusCode.value())
    }

    @Test
    fun `a handshake with a non-Bearer scheme answers 401`() {
        assertEquals(401, handshake("Basic aG9zdDpzZWNyZXQ=").statusCode.value())
    }

    @Test
    fun `a handshake with a wrong token answers 401`() {
        assertEquals(401, handshake("Bearer osm_host_${host.id}_wrong").statusCode.value())
    }

    @Test
    fun `a command reaches the host only while it is connected, and its result is applied`() {
        // No host yet: the command is undeliverable and must fail fast rather than queue.
        assertEquals(503, setup().statusCode.value())

        val socket = connect(token())
        // Nothing can be set up until the host has said what it can log in with.
        socket.send(announce(loginMethods = listOf("device_code")))
        // Registration happens in the server's connect callback, so retry until it is deliverable.
        awaitUntil { setup().statusCode.value() == 200 }
        awaitUntil { socket.received.any { it.type == CommandType.SETUP_AGENT } }

        val command = socket.received.first { it.type == CommandType.SETUP_AGENT }
        assertEquals(agent.id, command.agentId)
        assertEquals(MessageKind.COMMAND, command.kind)
        // The method the operator chose is relayed uninterpreted; no account hint accompanies it.
        assertEquals("device_code", command.payload?.get("method")?.asString())

        socket.send(
            HostEnvelope(
                id = command.id,
                kind = MessageKind.RESULT,
                type = CommandType.SETUP_AGENT,
                agentId = agent.id,
                ok = true,
                payload = objectMapper.valueToTree(
                    mapOf("mcUsername" to "Probe_01", "mcUuid" to "069a79f4-44e9-4726-a5be-fca90e38aaf5"),
                ),
            ),
        )

        awaitUntil { agentRepository.findById(agent.id!!).orElseThrow().state == AgentState.LINKED }

        val linked = agentRepository.findById(agent.id!!).orElseThrow()
        assertEquals("Probe_01", linked.mcUsername)
        assertEquals("069a79f4-44e9-4726-a5be-fca90e38aaf5", linked.mcUuid)

        socket.close()
    }

    /**
     * State is stored, so it outlives the connection that reported it. A host that restarts leaves
     * the backend asserting sessions nobody is running, and `agent_status` never contradicts it —
     * it says what changed, never what exists. The arrival announcement is what closes that.
     */
    @Test
    fun `an agent the host does not announce is taken off online`() {
        agent.state = AgentState.ONLINE
        agent.onlineSince = Instant.now()
        agent.chatListener = true
        agentRepository.saveAndFlush(agent)

        val second = agentRepository.saveAndFlush(
            Agent(label = "Probe_02", host = host, serverAddress = "mc.example.com:25565", state = AgentState.ONLINE),
        )

        val socket = connect(token())
        // Only the second agent is still running; the first went with the process that restarted.
        socket.send(
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.HANDSHAKE,
                payload = objectMapper.valueToTree(
                    mapOf("agents" to listOf(mapOf("agentId" to second.id, "state" to "ONLINE"))),
                ),
            ),
        )

        awaitUntil { agentRepository.findById(agent.id!!).orElseThrow().state == AgentState.LINKED }

        val dropped = agentRepository.findById(agent.id!!).orElseThrow()
        // Not UNLINKED: the credentials are on the host's disk and outlived the restart.
        assertEquals(AgentState.LINKED, dropped.state)
        assertNull(dropped.onlineSince)
        // A listener that is not in game must leave a vacancy the next election can fill.
        assertFalse(dropped.chatListener)

        // Announced, so untouched.
        assertEquals(AgentState.ONLINE, agentRepository.findById(second.id!!).orElseThrow().state)

        socket.close()
    }

    /** The command went with the process that was going to answer it, so nothing is coming. */
    @Test
    fun `an unannounced agent mid-setup goes back to where setup started`() {
        agent.state = AgentState.SETUP_PENDING
        agentRepository.saveAndFlush(agent)

        val socket = connect(token())
        socket.send(
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.HANDSHAKE,
                payload = objectMapper.valueToTree(mapOf("agents" to emptyList<Map<String, Any>>())),
            ),
        )

        awaitUntil { agentRepository.findById(agent.id!!).orElseThrow().state == AgentState.UNLINKED }

        socket.close()
    }

    /** Omitting the announcement has to change nothing, or an older host breaks on upgrade. */
    @Test
    fun `a host that never announces leaves state alone`() {
        agent.state = AgentState.ONLINE
        agentRepository.saveAndFlush(agent)

        val socket = connect(token())
        socket.send(
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.HEARTBEAT,
                payload = objectMapper.valueToTree(mapOf("hostVersion" to "0.9.9-probe")),
            ),
        )
        awaitUntil { hostRepository.findById(host.id!!).orElseThrow().isReachable() }

        assertEquals(AgentState.ONLINE, agentRepository.findById(agent.id!!).orElseThrow().state)

        socket.close()
    }

    // ---- what a host can log in with -------------------------------------------------------

    /**
     * The host is the authority on which mechanisms exist. The backend held four placeholders
     * before this and offered them to every host, which meant offering three that would fail.
     */
    @Test
    fun `a host's advertised login methods reach the frontend and leave with it`() {
        val socket = connect(token())
        socket.send(announce(loginMethods = listOf("device_code", "token_paste")))

        awaitUntil { hosts().contains("device_code") }
        assertTrue(hosts().contains("token_paste"))

        socket.close()

        // Not stored, so it goes with the connection that claimed it: the list is a statement
        // about a running process, and a machine that is gone offers nothing.
        awaitUntil { !hosts().contains("device_code") }
    }

    @Test
    fun `a method the host never advertised is refused before anything is dispatched`() {
        val socket = connect(token())
        socket.send(announce(loginMethods = listOf("device_code")))

        // 503 until the socket registers, then 400 for a method this host did not offer.
        awaitUntil { setup("token_paste").statusCode.value() == 400 }

        // Refused at the API, so the host was never asked and the agent never left UNLINKED —
        // which is the whole point of checking here rather than waiting for a setup_result.
        assertEquals(AgentState.UNLINKED, agentRepository.findById(agent.id!!).orElseThrow().state)
        assertTrue(socket.received.none { it.type == CommandType.SETUP_AGENT })

        socket.close()
    }

    /** A host that says nothing can set nothing up, rather than everything failing later. */
    @Test
    fun `a connected host that advertises nothing refuses every method`() {
        val socket = connect(token())
        socket.send(announce(agents = emptyList()))

        // 503 until the socket registers, then 400 rather than 200: connected is not enough.
        awaitUntil { setup().statusCode.value() == 400 }

        socket.close()
    }

    @Test
    fun `an unknown event does not drop the connection`() {
        val socket = connect(token())

        socket.send(
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = "something_a_newer_host_sends",
                payload = objectMapper.valueToTree(mapOf("whatever" to true)),
            ),
        )
        socket.session.sendMessage(TextMessage("this is not json at all"))

        // Forward compatibility: neither should be fatal, so a heartbeat must still land.
        socket.send(
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.HEARTBEAT,
                payload = objectMapper.valueToTree(mapOf("hostVersion" to "0.9.9-probe")),
            ),
        )
        awaitUntil { hostRepository.findById(host.id!!).orElseThrow().isReachable() }

        socket.close()
    }

    // ---- helpers ---------------------------------------------------------------------------

    private fun token() = "osm_host_${host.id}_$secret"

    private fun setup(method: String = "device_code") = RestClient.create()
        .post()
        .uri("http://localhost:$port/api/agents/${agent.id}/setup")
        .header(HttpHeaders.AUTHORIZATION, "Bearer $jwt")
        .contentType(MediaType.APPLICATION_JSON)
        .body("""{"method":"$method"}""")
        .exchange { _, response -> response }

    private fun hosts() = RestClient.create()
        .get()
        .uri("http://localhost:$port/api/hosts")
        .header(HttpHeaders.AUTHORIZATION, "Bearer $jwt")
        .retrieve()
        .body(String::class.java)
        .orEmpty()

    /** What a host says on arrival. Both halves are optional, so each is omitted when not given. */
    private fun announce(
        agents: List<Map<String, Any?>>? = null,
        loginMethods: List<String>? = null,
    ) = HostEnvelope(
        kind = MessageKind.EVENT,
        type = EventType.HANDSHAKE,
        payload = objectMapper.valueToTree(
            buildMap {
                agents?.let { put("agents", it) }
                loginMethods?.let { ids -> put("loginMethods", ids.map { mapOf("id" to it) }) }
            },
        ),
    )

    /**
     * The handshake driven over plain HTTP, so the status is readable — a WebSocket client only
     * reports that the upgrade failed.
     *
     * No upgrade headers: the interceptor runs before the handshake handler validates them, so this
     * reaches the same code either way, and `java.net.http` refuses to send `Connection` and
     * `Upgrade` as a matter of policy.
     */
    private fun handshake(authorization: String?) = RestClient.create()
        .get()
        .uri("http://localhost:$port/ws/host")
        .headers { headers -> authorization?.let { headers.set(HttpHeaders.AUTHORIZATION, it) } }
        .exchange { _, response -> response }

    private fun login(username: String, password: String): String {
        val body = RestClient.create()
            .post()
            .uri("http://localhost:$port/api/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .body("""{"username":"$username","password":"$password"}""")
            .retrieve()
            .body(String::class.java)
        return com.jayway.jsonpath.JsonPath.read(body, "$.token")
    }

    private fun connect(token: String): ProbeHost {
        val headers = WebSocketHttpHeaders().apply { add(HttpHeaders.AUTHORIZATION, "Bearer $token") }
        val probe = ProbeHost(objectMapper)
        val session = StandardWebSocketClient()
            .execute(probe, headers, java.net.URI("ws://localhost:$port/ws/host"))
            .get(5, java.util.concurrent.TimeUnit.SECONDS)
        probe.session = session
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

        fun send(envelope: HostEnvelope) {
            session.sendMessage(TextMessage(objectMapper.writeValueAsString(envelope)))
        }

        fun close() = session.close(CloseStatus.NORMAL)
    }
}

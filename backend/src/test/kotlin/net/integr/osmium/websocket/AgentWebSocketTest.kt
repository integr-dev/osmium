package net.integr.osmium.websocket

import net.integr.osmium.TestcontainersConfiguration
import net.integr.osmium.model.Bot
import net.integr.osmium.model.BotState
import net.integr.osmium.model.Host
import net.integr.osmium.model.User
import net.integr.osmium.repository.BotRepository
import net.integr.osmium.repository.HostRepository
import net.integr.osmium.repository.RoleRepository
import net.integr.osmium.repository.UserRepository
import net.integr.osmium.security.RoleNames
import net.integr.osmium.security.encodeRequired
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
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

/**
 * End-to-end over a real WebSocket: an agent authenticates with its enrolment token, heartbeats,
 * receives a command and answers it.
 *
 * Deliberately not @Transactional. The agent runs on other threads, so a rolled-back test
 * transaction would be invisible to it; state is committed and cleaned up explicitly instead.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestcontainersConfiguration::class)
class AgentWebSocketTest {

    @LocalServerPort private var port: Int = 0

    @Autowired private lateinit var hostRepository: HostRepository
    @Autowired private lateinit var botRepository: BotRepository
    @Autowired private lateinit var userRepository: UserRepository
    @Autowired private lateinit var roleRepository: RoleRepository
    @Autowired private lateinit var passwordEncoder: PasswordEncoder
    @Autowired private lateinit var objectMapper: ObjectMapper

    private lateinit var host: Host
    private lateinit var bot: Bot
    private lateinit var jwt: String
    private val secret = "s3cr3t-probe"

    @BeforeEach
    fun setUp() {
        cleanUp()

        host = hostRepository.saveAndFlush(
            Host(name = "agent-probe", tokenHash = passwordEncoder.encodeRequired(secret)),
        )
        bot = botRepository.saveAndFlush(
            Bot(
                label = "Probe_01",
                host = host,
                serverAddress = "mc.example.com:25565",
                state = BotState.UNLINKED,
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
        botRepository.deleteAll()
        hostRepository.deleteAll()
        userRepository.findByUsername("ws-operator")?.let { userRepository.delete(it) }
    }

    @Test
    fun `an agent authenticates with its token, and its heartbeat makes the host reachable`() {
        assertFalse(hostRepository.findById(host.id!!).orElseThrow().isReachable())

        val agent = connect(token())
        agent.send(
            AgentEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.HEARTBEAT,
                payload = objectMapper.valueToTree(mapOf("agentVersion" to "0.9.9-probe")),
            ),
        )

        awaitUntil { hostRepository.findById(host.id!!).orElseThrow().isReachable() }

        val refreshed = hostRepository.findById(host.id!!).orElseThrow()
        assertEquals("0.9.9-probe", refreshed.agentVersion)
        // The address is observed on connect, which is why enrolment never asks for one.
        assertTrue(refreshed.address != null)

        agent.close()
    }

    @Test
    fun `a wrong token is refused at the handshake`() {
        val failure = runCatching { connect("osm_ag_${host.id}_wrong") }
        assertTrue(failure.isFailure, "the handshake should have been rejected")
    }

    @Test
    fun `a command reaches the agent only while it is connected, and its result is applied`() {
        // No agent yet: the command is undeliverable and must fail fast rather than queue.
        assertEquals(503, setup().statusCode.value())

        val agent = connect(token())
        // Registration happens in the server's connect callback, so retry until it is deliverable.
        awaitUntil { setup().statusCode.value() == 200 }
        awaitUntil { agent.received.any { it.type == CommandType.SETUP_BOT } }

        val command = agent.received.first { it.type == CommandType.SETUP_BOT }
        assertEquals(bot.id, command.botId)
        assertEquals(MessageKind.COMMAND, command.kind)
        // The method the operator chose is relayed uninterpreted; no account hint accompanies it.
        assertEquals("device_code", command.payload?.get("method")?.asString())

        agent.send(
            AgentEnvelope(
                id = command.id,
                kind = MessageKind.RESULT,
                type = CommandType.SETUP_BOT,
                botId = bot.id,
                ok = true,
                payload = objectMapper.valueToTree(
                    mapOf("mcUsername" to "Probe_01", "mcUuid" to "069a79f4-44e9-4726-a5be-fca90e38aaf5"),
                ),
            ),
        )

        awaitUntil { botRepository.findById(bot.id!!).orElseThrow().state == BotState.LINKED }

        val linked = botRepository.findById(bot.id!!).orElseThrow()
        assertEquals("Probe_01", linked.mcUsername)
        assertEquals("069a79f4-44e9-4726-a5be-fca90e38aaf5", linked.mcUuid)

        agent.close()
    }

    @Test
    fun `an unknown event does not drop the connection`() {
        val agent = connect(token())

        agent.send(
            AgentEnvelope(
                kind = MessageKind.EVENT,
                type = "something_a_newer_agent_sends",
                payload = objectMapper.valueToTree(mapOf("whatever" to true)),
            ),
        )
        agent.session.sendMessage(TextMessage("this is not json at all"))

        // Forward compatibility: neither should be fatal, so a heartbeat must still land.
        agent.send(
            AgentEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.HEARTBEAT,
                payload = objectMapper.valueToTree(mapOf("agentVersion" to "0.9.9-probe")),
            ),
        )
        awaitUntil { hostRepository.findById(host.id!!).orElseThrow().isReachable() }

        agent.close()
    }

    // ---- helpers ---------------------------------------------------------------------------

    private fun token() = "osm_ag_${host.id}_$secret"

    private fun setup() = RestClient.create()
        .post()
        .uri("http://localhost:$port/api/bots/${bot.id}/setup")
        .header(HttpHeaders.AUTHORIZATION, "Bearer $jwt")
        .contentType(MediaType.APPLICATION_JSON)
        .body("""{"method":"device_code"}""")
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

    private fun connect(token: String): ProbeAgent {
        val headers = WebSocketHttpHeaders().apply { add(HttpHeaders.AUTHORIZATION, "Bearer $token") }
        val probe = ProbeAgent(objectMapper)
        val session = StandardWebSocketClient()
            .execute(probe, headers, java.net.URI("ws://localhost:$port/ws/agent"))
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

    private class ProbeAgent(private val objectMapper: ObjectMapper) : TextWebSocketHandler() {
        lateinit var session: WebSocketSession
        val received = CopyOnWriteArrayList<AgentEnvelope>()

        override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
            received += objectMapper.readValue(message.payload, AgentEnvelope::class.java)
        }

        fun send(envelope: AgentEnvelope) {
            session.sendMessage(TextMessage(objectMapper.writeValueAsString(envelope)))
        }

        fun close() = session.close(CloseStatus.NORMAL)
    }
}

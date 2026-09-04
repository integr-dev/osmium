package net.integr.osmium.agent.service

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.host.model.Host
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.agent.dto.AgentResponse
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.WebSocketExtension
import org.springframework.web.socket.WebSocketMessage
import org.springframework.web.socket.WebSocketSession
import tools.jackson.databind.ObjectMapper
import java.net.InetSocketAddress
import java.net.URI
import java.security.Principal
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Automatic rejoining, which is the backend's job and not the host's.
 *
 * The host is where a disconnect is noticed and it is still the wrong place to answer one: a host
 * never decides where an agent belongs, it reports where the agent got to. So the wish lives here,
 * on `Agent.wanted`, and a sweep closes the gap between the wish and the report.
 *
 * The sweep is derived rather than event-driven - it reads the fleet as it is now rather than
 * reacting to a transition - so every test here sets up a *state* and runs one sweep, which is also
 * how it behaves after a backend restart or a report that never arrived.
 */
class AgentRejoinTest : AbstractRestTest() {

    @Autowired private lateinit var agentService: AgentService
    @Autowired private lateinit var auditEntries: AuditEntryRepository
    @Autowired private lateinit var broker: LiveUpdateBroker
    @Autowired private lateinit var connections: HostConnections
    @Autowired private lateinit var objectMapper: ObjectMapper

    /** An agent that wants to be in game, has fallen out of it, and is configured to go back. */
    private fun fallen(
        host: Host,
        state: AgentState = AgentState.LINKED,
        rejoin: Boolean = true,
        attempts: Int = 0,
        due: Instant? = null,
    ): Agent {
        val agent = createAgent("Mason_01", host, state = state)
        agent.wanted = true
        agent.rejoinAttempts = attempts
        agent.rejoinAt = due
        if (rejoin) agent.settings = """{"connect.rejoin":"true"}"""
        return agentRepository.saveAndFlush(agent)
    }

    private fun reload(agent: Agent): Agent = agentRepository.findById(checkNotNull(agent.id)).orElseThrow()

    private fun listen(host: Host): FakeSocket =
        FakeSocket(objectMapper).also { connections.register(checkNotNull(host.id), it) }

    /**
     * Armed, not dialled. A server that has just restarted is not ready for a client and neither is
     * one that has just kicked us, so the first sweep to notice an absence starts the clock rather
     * than reconnecting into whatever caused it.
     */
    @Test
    fun `a drop starts the clock instead of an immediate reconnect`() {
        val agent = fallen(reachableHost())

        agentService.rejoinTheWilling()

        val armed = reload(agent)
        assertEquals(AgentState.LINKED, armed.state)
        assertEquals(0, armed.rejoinAttempts)
        assertTrue(assertNotNull(armed.rejoinAt).isAfter(Instant.now()))
    }

    @Test
    fun `nothing is dialled before the delay is up`() {
        val host = reachableHost()
        val socket = listen(host)
        val agent = fallen(host, due = Instant.now().plus(Duration.ofMinutes(5)))

        agentService.rejoinTheWilling()

        assertEquals(AgentState.LINKED, reload(agent).state)
        assertTrue(socket.commands(CommandType.CONNECT).isEmpty())
    }

    @Test
    fun `a rejoin that has come due goes out as an ordinary connect`() {
        val host = reachableHost()
        val socket = listen(host)
        val agent = fallen(host, due = Instant.now().minusSeconds(1))

        agentService.rejoinTheWilling()

        val dialling = reload(agent)
        assertEquals(AgentState.CONNECTING, dialling.state)
        assertNotNull(dialling.connectingSince)
        assertEquals(1, dialling.rejoinAttempts)
        // Rearmed on the way out, so a failure that lands back on CONNECT_FAILED waits the next
        // delay rather than being retried by the following sweep five seconds later.
        assertTrue(assertNotNull(dialling.rejoinAt).isAfter(Instant.now()))

        val sent = socket.commands(CommandType.CONNECT)
        assertEquals(1, sent.size)
        assertEquals(agent.id, sent.single().agentId)
        assertEquals("mc.example.com", sent.single().payload?.get("serverAddress")?.asString())
    }

    /** CONNECT_FAILED is the state a rejoin most often has to work from, and it is connectable. */
    @Test
    fun `a refused connect is retried like any other absence`() {
        val host = reachableHost()
        val socket = listen(host)
        val agent = fallen(host, state = AgentState.CONNECT_FAILED, due = Instant.now().minusSeconds(1))

        agentService.rejoinTheWilling()

        assertEquals(AgentState.CONNECTING, reload(agent).state)
        assertEquals(1, socket.commands(CommandType.CONNECT).size)
    }

    /** The setting is the whole feature. Without it this is exactly the behaviour it replaced. */
    @Test
    fun `an agent nobody configured is left where it fell`() {
        val host = reachableHost()
        val socket = listen(host)
        val agent = fallen(host, rejoin = false, due = Instant.now().minusSeconds(1))

        agentService.rejoinTheWilling()

        assertEquals(AgentState.LINKED, reload(agent).state)
        assertTrue(socket.commands(CommandType.CONNECT).isEmpty())
    }

    /**
     * The one thing that must never happen. An operator who takes an agent out of the game and finds
     * it back in thirty seconds later has been given a Disconnect button that does not work.
     */
    @Test
    fun `an operator's disconnect keeps the agent out`() {
        val host = reachableHost()
        val socket = listen(host)
        val agent = fallen(host, state = AgentState.ONLINE, due = Instant.now().minusSeconds(1))

        agentService.disconnect(checkNotNull(agent.id))
        // The host has left the game and said so, which is indistinguishable from a kick - which is
        // the point: `wanted` is what tells the two apart, not the state that follows.
        val parted = reload(agent).also { it.state = AgentState.LINKED }
        agentRepository.saveAndFlush(parted)

        agentService.rejoinTheWilling()

        val left = reload(agent)
        assertFalse(left.wanted)
        assertNull(left.rejoinAt)
        assertEquals(AgentState.LINKED, left.state)
        assertTrue(socket.commands(CommandType.CONNECT).isEmpty())
    }

    /**
     * Cancelling a rejoin has to reach the browser, and it is the one disconnect nothing else does.
     *
     * An agent in the game leaves and its host reports having left, and that report publishes; an
     * agent waiting out a backoff has no host round trip at all. Without a push of its own, every
     * page open on it went on offering to stop something that had already stopped - and the second
     * press came back "it is not connected and is not trying to be".
     *
     * Not transactional, because the broker defers delivery until after commit: inside a rolled-back
     * test transaction nothing is ever delivered.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `stopping a rejoin is pushed to the browser`() {
        val host = reachableHost("host-push")
        val agent = agentRepository.saveAndFlush(
            Agent(
                label = "Mason_push",
                host = host,
                serverAddress = "mc.example.com",
                state = AgentState.LINKED,
                wanted = true,
                rejoinAttempts = 2,
                rejoinAt = Instant.now().plusSeconds(30),
            ),
        )

        val seen = CopyOnWriteArrayList<LiveUpdateEvent>()
        broker.subscribe { seen += it }

        try {
            agentService.disconnect(checkNotNull(agent.id))

            val pushed = seen.lastOrNull {
                it.type == LiveUpdateType.AGENT_CHANGED && it.agentId == agent.id
            }
            assertNotNull(pushed, "cancelling a rejoin never reached the browser")
            assertFalse(
                (pushed.data as AgentResponse).rejoining,
                "the browser was told about an agent that is still trying",
            )
        } finally {
            // Everything this test committed, the audit line included: it runs outside the
            // transaction the rest are rolled back with, so what it writes is what the next test
            // reads. The trail is walked whole by the audit tests, and one stray row fails them.
            agentRepository.deleteById(checkNotNull(agent.id))
            hostRepository.deleteById(checkNotNull(host.id))
            auditEntries.deleteAll(auditEntries.findAll().filter { it.target == agent.label })
        }
    }

    /** And the other direction: pressing Connect is what records the wish in the first place. */
    @Test
    fun `connecting an agent is what makes it wanted`() {
        val host = reachableHost()
        listen(host)
        val agent = createAgent("Mason_01", host, state = AgentState.LINKED)

        agentService.connect(checkNotNull(agent.id))

        assertTrue(reload(agent).wanted)
    }

    /**
     * A host that is switched off is not the agent failing to join. Counting it would spend the whole
     * budget on somebody else's outage and give up exactly as the host came back.
     */
    @Test
    fun `an unreachable host does not spend the budget`() {
        val agent = fallen(unreachableHost(), attempts = 3, due = Instant.now().minusSeconds(1))

        agentService.rejoinTheWilling()

        val untouched = reload(agent)
        assertEquals(3, untouched.rejoinAttempts)
        assertTrue(untouched.wanted)
        assertEquals(AgentState.LINKED, untouched.state)
    }

    /**
     * Bounded on purpose. An agent that cannot join *this* server will not be fixed by another
     * thousand tries, and a warning every five minutes forever is a feed nobody reads.
     */
    @Test
    fun `it stops trying rather than dialling forever`() {
        val host = reachableHost()
        val socket = listen(host)
        val agent = fallen(host, attempts = 10, due = Instant.now().minusSeconds(1))

        agentService.rejoinTheWilling()

        val abandoned = reload(agent)
        assertFalse(abandoned.wanted)
        assertNull(abandoned.rejoinAt)
        assertEquals(AgentState.LINKED, abandoned.state)
        assertTrue(socket.commands(CommandType.CONNECT).isEmpty())
    }

    /**
     * The backoff describes one absence. An agent that has been playing for a week should start from
     * the shortest delay when it finally drops, not inherit the patience of whatever went wrong last
     * month.
     */
    @Test
    fun `getting back in game clears the backoff`() {
        val agent = fallen(reachableHost(), state = AgentState.ONLINE, attempts = 6, due = Instant.now())

        agentService.rejoinTheWilling()

        val recovered = reload(agent)
        assertEquals(0, recovered.rejoinAttempts)
        assertNull(recovered.rejoinAt)
        assertTrue(recovered.wanted)
    }

    /**
     * A host socket that records instead of writing.
     *
     * Hand-written rather than mocked: `HostConnections.send` is the real path under test, including
     * the serialisation, and the only part of a session it touches is `isOpen` and `sendMessage`.
     */
    private class FakeSocket(private val objectMapper: ObjectMapper) : WebSocketSession {
        private val sent = CopyOnWriteArrayList<HostEnvelope>()

        fun commands(type: String): List<HostEnvelope> = sent.filter { it.type == type }

        override fun sendMessage(message: WebSocketMessage<*>) {
            sent += objectMapper.readValue(message.payload as String, HostEnvelope::class.java)
        }

        override fun isOpen(): Boolean = true
        override fun getId(): String = "fake"
        override fun getUri(): URI? = null
        override fun getHandshakeHeaders(): HttpHeaders = HttpHeaders.EMPTY
        override fun getAttributes(): MutableMap<String, Any> = mutableMapOf()
        override fun getPrincipal(): Principal? = null
        override fun getLocalAddress(): InetSocketAddress? = null
        override fun getRemoteAddress(): InetSocketAddress? = null
        override fun getAcceptedProtocol(): String? = null
        override fun setTextMessageSizeLimit(messageSizeLimit: Int) = Unit
        override fun getTextMessageSizeLimit(): Int = 0
        override fun setBinaryMessageSizeLimit(messageSizeLimit: Int) = Unit
        override fun getBinaryMessageSizeLimit(): Int = 0
        override fun getExtensions(): MutableList<WebSocketExtension> = mutableListOf()
        override fun close() = Unit
        override fun close(status: CloseStatus) = Unit
    }
}

package net.integr.osmium.agent.service

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostReportService
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.host.model.Host
import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.get
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Telemetry rides inside `agent_status` but is handled on its own terms: taken every tick, kept in
 * memory, and aged out rather than cleared. These cover the seams where that differs from state.
 */
class AgentTelemetryTest : AbstractRestTest() {

    @Autowired private lateinit var hostReports: HostReportService
    @Autowired private lateinit var telemetryStore: AgentTelemetryStore
    @Autowired private lateinit var telemetryPublisher: AgentTelemetryPublisher
    @Autowired private lateinit var agentService: AgentService
    @Autowired private lateinit var broker: FleetEventBroker
    @Autowired private lateinit var objectMapper: ObjectMapper

    private fun status(agent: Agent, payload: String) = HostEnvelope(
        kind = MessageKind.EVENT,
        type = EventType.AGENT_STATUS,
        agentId = agent.id,
        payload = objectMapper.readTree(payload),
    )

    private val vitals = """
        {"state":"ONLINE","health":18,"food":17,"dimension":"the_nether","pingMs":42,
         "position":{"x":128.5,"y":71.0,"z":-344.25}}
    """.trimIndent()

    @Test
    fun `a reported sample is readable on the agent`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE)

        hostReports.onMessage(checkNotNull(host.id), status(agent, vitals))

        val telemetry = assertNotNull(telemetryStore.find(agent.id))
        assertEquals(18, telemetry.health)
        assertEquals(17, telemetry.food)
        assertEquals("the_nether", telemetry.dimension)
        assertEquals(42, telemetry.pingMs)
        assertEquals(128.5, telemetry.position.x)
        assertEquals(-344.25, telemetry.position.z)
    }

    @Test
    fun `telemetry reaches the browser through the agent endpoint`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE)
        hostReports.onMessage(checkNotNull(host.id), status(agent, vitals))

        mockMvc.get("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$.telemetry.health") { value(18) }
            jsonPath("$.telemetry.position.y") { value(71.0) }
        }
    }

    /** An agent that has never reported has no vitals, rather than a row of convincing zeroes. */
    @Test
    fun `an agent that has not reported has null telemetry`() {
        val agent = createAgent("Mason_01", reachableHost(), state = AgentState.ONLINE)

        mockMvc.get("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$.telemetry") { value(null as String?) }
        }

        assertNull(telemetryStore.find(agent.id))
    }

    /**
     * The half that is durable and the half that is not. State is written only when it changes;
     * telemetry is taken from every tick, so a host repeating ONLINE still moves the numbers.
     */
    @Test
    fun `a repeated status updates the vitals without touching the state`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE)
        val before = agentRepository.findById(checkNotNull(agent.id)).orElseThrow().onlineSince

        hostReports.onMessage(checkNotNull(host.id), status(agent, vitals))
        hostReports.onMessage(
            checkNotNull(host.id),
            status(agent, """{"state":"ONLINE","health":6,"food":3,"pingMs":180}"""),
        )

        assertEquals(6, telemetryStore.find(agent.id)?.health)
        val after = agentRepository.findById(checkNotNull(agent.id)).orElseThrow()
        assertEquals(AgentState.ONLINE, after.state)
        assertEquals(before, after.onlineSince)
    }

    /** A tick with no vitals is a state report, and must not blank what was last known. */
    @Test
    fun `a status carrying only a state leaves the last sample alone`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE)
        hostReports.onMessage(checkNotNull(host.id), status(agent, vitals))

        hostReports.onMessage(checkNotNull(host.id), status(agent, """{"state":"ONLINE"}"""))

        assertEquals(18, telemetryStore.find(agent.id)?.health)
    }

    /**
     * Decided by the backend, because a host sees only its own agents — and a server's fleet can
     * span several hosts, so no host can tell one of ours from a stranger.
     */
    @Test
    fun `a nearby player is marked as an agent only when the fleet knows the name`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE)
        agentRepository.saveAndFlush(
            createAgent("Mason_02", host, state = AgentState.ONLINE).apply { mcUsername = "Mason_02" },
        )

        hostReports.onMessage(
            checkNotNull(host.id),
            status(
                agent,
                """{"state":"ONLINE","health":20,
                    "nearby":[{"name":"Mason_02","distance":4.5},{"name":"Notch","distance":19.0}]}""",
            ),
        )

        val nearby = assertNotNull(telemetryStore.find(agent.id)).nearby
        assertEquals(2, nearby.size)
        assertTrue(nearby.single { it.name == "Mason_02" }.isAgent)
        assertFalse(nearby.single { it.name == "Notch" }.isAgent)
        assertEquals(4.5, nearby.single { it.name == "Mason_02" }.distance)
    }

    /** Deleting an agent drops its sample, so the store cannot outgrow the fleet. */
    @Test
    fun `deleting an agent forgets its telemetry`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.LINKED)
        hostReports.onMessage(checkNotNull(host.id), status(agent, vitals))
        assertNotNull(telemetryStore.find(agent.id))

        agentService.delete(checkNotNull(agent.id))

        assertNull(telemetryStore.find(agent.id))
    }

    /**
     * The seam between ingest and the browser: a report has to mark the agent, or vitals reach the
     * store and are never pushed to anyone.
     *
     * Only the wiring is asserted here. *When* the push happens belongs to `AgentTelemetryPublisher`
     * and is covered deterministically there — the real scheduler is running in this context, so a
     * "nothing yet" assertion would be racing a tick that fires every second.
     *
     * Not transactional, because the broker defers delivery until after commit: inside a rolled-back
     * test transaction nothing is ever delivered, and the test would fail for a reason unrelated to
     * the code under test.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `a reported sample is pushed to the browser`() {
        val host = hostRepository.saveAndFlush(
            Host(name = "host-tick", tokenHash = "hash", lastSeenAt = Instant.now()),
        )
        val agent = agentRepository.saveAndFlush(
            Agent(label = "Mason_tick", host = host, serverAddress = "mc.example.com:25565", state = AgentState.ONLINE),
        )

        val seen = CopyOnWriteArrayList<FleetEvent>()
        broker.subscribe { seen += it }

        hostReports.onMessage(checkNotNull(host.id), status(agent, vitals))
        telemetryPublisher.flush()

        // Scoped to this agent: the store and the pending set outlive a rolled-back transaction, so
        // agents from earlier tests can still be in flight on the scheduler's own tick.
        assertTrue(
            seen.any { it.type == FleetEventType.AGENT_TELEMETRY && it.agentId == agent.id },
            "the reported sample never reached the browser",
        )

        agentRepository.deleteById(checkNotNull(agent.id))
        hostRepository.deleteById(checkNotNull(host.id))
    }

    /** A host reporting on an agent it does not own is rejected here as everywhere else. */
    @Test
    fun `a host cannot report telemetry for an agent it does not own`() {
        val agent = createAgent("Mason_01", reachableHost("host-a"), state = AgentState.ONLINE)
        val intruder = reachableHost("host-b")

        hostReports.onMessage(checkNotNull(intruder.id), status(agent, vitals))

        assertNull(telemetryStore.find(agent.id))
    }
}

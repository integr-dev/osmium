package net.integr.osmium.map

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostReportService
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.map.model.SubjectKind
import net.integr.osmium.map.service.LastSeenService
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.get
import tools.jackson.databind.ObjectMapper
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Where the fleet last saw everyone: what a telemetry sample leaves behind once it has gone.
 *
 * The seam worth testing is that this record outlives the sample it came from. Telemetry is held in
 * memory and describes only the moment it arrived; these rows are what a map draws in grey an hour
 * later, so what they assert is that the write happened at all, that it is keyed by the world, and
 * that another agent's sighting of somebody does not become a row of its own.
 */
class LastSeenTest : AbstractRestTest() {

    @Autowired private lateinit var hostReports: HostReportService
    @Autowired private lateinit var lastSeen: LastSeenService
    @Autowired private lateinit var objectMapper: ObjectMapper

    /**
     * A server nothing else in the suite plays on.
     *
     * Sightings outlive a test: the flush that writes them runs on a scheduler with no transaction
     * to be rolled back with, and other classes report telemetry of their own. Reading a world that
     * is this class's alone is what makes "the agent and the stranger, and nobody else" a statement
     * about this test rather than about the order the suite happened to run in.
     */
    private val server = "lastseen.example.com"

    /**
     * Empties the buffer before each test.
     *
     * The service is a singleton in a context shared by the whole suite, so a telemetry sample
     * reported by another class is still sitting in it, unflushed - and the first `flush()` here
     * would write it and count it. Drained into this test's own transaction, which is rolled back.
     */
    @BeforeEach
    fun drain() = lastSeen.flush()

    private fun status(agent: Agent, payload: String) = HostEnvelope(
        kind = MessageKind.EVENT,
        type = EventType.AGENT_STATUS,
        agentId = agent.id,
        payload = objectMapper.readTree(payload),
    )

    /** Somebody who is not ours, with an account, standing eight blocks away. */
    private val stranger =
        """{"name":"Notch","distance":8.0,"uuid":"abc","position":{"x":18.0,"y":64.0,"z":-22.0}}"""

    /** One of ours, as a neighbour sees it: a name and a position, and no idea that it is ours. */
    private val neighbour =
        """{"name":"Mason_02","distance":4.0,"position":{"x":11.0,"y":64.0,"z":-20.0}}"""

    private fun sample(
        dimension: String = "overworld",
        x: Double = 10.0,
        nearby: List<String> = listOf(stranger),
    ) = """
        {"state":"ONLINE","health":20,"food":20,"pingMs":30,"dimension":"$dimension",
         "position":{"x":$x,"y":64.0,"z":-20.0},
         "nearby":[${nearby.joinToString(",")}]}
    """.trimIndent()

    /**
     * Reported, buffered, flushed, read. The flush is called rather than waited for: it is on a
     * fixed delay in production and the point here is what it writes, not when.
     */
    @Test
    fun `a sample leaves a position for the agent and for the stranger beside it`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE, server = server)

        hostReports.onMessage(checkNotNull(host.id), status(agent, sample()))
        lastSeen.flush()

        val stored = lastSeen.inWorld(server, "overworld")
        assertEquals(2, stored.size, "the agent and the stranger, and nobody else")

        val ours = stored.single { it.kind == SubjectKind.AGENT }
        assertEquals(agent.id.toString(), ours.subject)
        assertEquals("Mason_01", ours.label)
        assertEquals(10.0, ours.x)
        assertEquals(-20.0, ours.z)

        val stranger = stored.single { it.kind == SubjectKind.PLAYER }
        assertEquals("Notch", stranger.subject)
        assertEquals("abc", stranger.face, "the uuid, which is what a head is fetched by")
        assertEquals(18.0, stranger.x)
    }

    /**
     * A second agent in the same fleet is `isAgent`, and it reports its own position from where it
     * is actually standing. Filing a row from what a neighbour could make out would put it in two
     * places at once, and the neighbour's guess is the worse of the two.
     */
    @Test
    fun `another agent seen nearby is left to report itself`() {
        val host = reachableHost()
        val first = createAgent("Mason_01", host, state = AgentState.ONLINE, server = server)
        createAgent("Mason_02", host, state = AgentState.ONLINE, server = server).also {
            it.mcUsername = "Mason_02"
            agentRepository.saveAndFlush(it)
        }

        hostReports.onMessage(
            checkNotNull(host.id),
            status(first, sample(nearby = listOf(stranger, neighbour))),
        )
        lastSeen.flush()

        val stored = lastSeen.inWorld(server, "overworld")
        assertNull(stored.firstOrNull { it.subject == "Mason_02" }, "it files its own")
    }

    /** The worlds are separate places at the same coordinates, so a sighting belongs to one. */
    @Test
    fun `a world of its own keeps its own sightings`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE, server = server)

        hostReports.onMessage(checkNotNull(host.id), status(agent, sample(x = 10.0)))
        lastSeen.flush()
        hostReports.onMessage(checkNotNull(host.id), status(agent, sample("the_nether", x = 900.0)))
        lastSeen.flush()

        assertEquals(10.0, lastSeen.inWorld(server, "overworld").single { it.kind == SubjectKind.AGENT }.x)
        assertEquals(900.0, lastSeen.inWorld(server, "the_nether").single { it.kind == SubjectKind.AGENT }.x)
    }

    /** The newest sighting stands: one row per person, replaced rather than appended to. */
    @Test
    fun `walking on replaces the position rather than adding one`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE, server = server)

        hostReports.onMessage(checkNotNull(host.id), status(agent, sample(x = 10.0)))
        lastSeen.flush()
        hostReports.onMessage(checkNotNull(host.id), status(agent, sample(x = 40.0)))
        lastSeen.flush()

        val ours = lastSeen.inWorld(server, "overworld").single { it.kind == SubjectKind.AGENT }
        assertEquals(40.0, ours.x)
    }

    @Test
    fun `the endpoint answers a viewer with what was stored`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, state = AgentState.ONLINE, server = server)
        hostReports.onMessage(checkNotNull(host.id), status(agent, sample()))
        lastSeen.flush()

        mockMvc.get("/api/map/last-seen?server=$server&dimension=overworld") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$.length()") { value(2) }
        }
    }

    @Test
    fun `sightings are behind agent read`() {
        mockMvc.get("/api/map/last-seen?server=$server&dimension=overworld").andExpect {
            status { isUnauthorized() }
        }
    }

    /** Nothing is written for an agent that is assigned nowhere: a position with no address. */
    @Test
    fun `an agent on no server files nothing`() {
        val host = reachableHost()
        val agent = agentRepository.saveAndFlush(
            Agent(label = "Mason_09", host = host, serverAddress = null, state = AgentState.ONLINE),
        )

        hostReports.onMessage(checkNotNull(host.id), status(agent, sample()))
        lastSeen.flush()

        assertTrue(lastSeen.inWorld(server, "overworld").isEmpty())
    }
}

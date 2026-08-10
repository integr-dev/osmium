package net.integr.osmium.activity.controller

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.activity.model.ActivityEntry
import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import net.integr.osmium.activity.repository.ActivityEntryRepository
import net.integr.osmium.activity.service.ActivityService
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostReportService
import net.integr.osmium.hostlink.MessageKind
import org.hamcrest.Matchers.contains
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.get
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ActivityControllerTest : AbstractRestTest() {

    @Autowired private lateinit var activityEntryRepository: ActivityEntryRepository
    @Autowired private lateinit var activityService: ActivityService
    @Autowired private lateinit var hostReports: HostReportService
    @Autowired private lateinit var objectMapper: ObjectMapper

    private fun incident(
        agent: Agent,
        text: String,
        severity: ActivitySeverity = ActivitySeverity.INFO,
        at: Instant = Instant.now(),
    ) = activityEntryRepository.saveAndFlush(
        ActivityEntry(
            at = at,
            agentId = agent.id,
            agentLabel = agent.label,
            scope = ActivityScope.SYSTEM,
            severity = severity,
            text = text,
        ),
    )

    // ---- reading -------------------------------------------------------------------------------

    @Test
    fun `the fleet feed merges every agent's incidents, newest first`() {
        val host = reachableHost()
        val one = createAgent("Mason_01", host)
        val two = createAgent("Mason_02", host)
        val now = Instant.now()
        incident(one, "older", at = now.minusSeconds(60))
        incident(two, "newer", at = now)

        mockMvc.get("/api/activity") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "viewer"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[*].text") { value(contains("newer", "older")) }
        }
    }

    @Test
    fun `agentId narrows the feed to one agent`() {
        val host = reachableHost()
        val one = createAgent("Mason_01", host)
        val two = createAgent("Mason_02", host)
        incident(one, "mine")
        incident(two, "theirs")

        mockMvc.get("/api/activity?agentId=${one.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "viewer"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[*].text") { value(contains("mine")) }
        }
    }

    /** "Mason_04 was banned" is precisely the line you want after Mason_04 has been deleted. */
    @Test
    fun `an incident outlives the agent it happened to`() {
        val agent = createAgent("Mason_01", reachableHost())
        incident(agent, "banned")
        agentRepository.deleteById(checkNotNull(agent.id))
        agentRepository.flush()

        mockMvc.get("/api/activity") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "viewer"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[0].agentLabel") { value("Mason_01") }
        }
    }

    @Test
    fun `the cursor walks the feed to the end`() {
        val agent = createAgent("Mason_01", reachableHost())
        val now = Instant.now()
        repeat(5) { index -> incident(agent, "event $index", at = now.minusSeconds(index.toLong())) }

        val seen = mutableListOf<String>()
        var cursor: String? = ""
        var pages = 0

        while (cursor != null) {
            val suffix = if (cursor.isEmpty()) "" else "&cursor=$cursor"
            val body = mockMvc.get("/api/activity?limit=2$suffix") {
                header(HttpHeaders.AUTHORIZATION, authAs("walker$pages", "viewer"))
            }.andExpect { status { isOk() } }.andReturn().response.contentAsString

            seen += JsonPath.read<List<String>>(body, "$.items[*].text")
            cursor = JsonPath.read<String?>(body, "$.nextCursor")
            pages++
        }

        assertEquals(listOf("event 0", "event 1", "event 2", "event 3", "event 4"), seen)
        assertEquals(3, pages)
    }

    @Test
    fun `an anonymous request is rejected`() {
        mockMvc.get("/api/activity").andExpect { status { isUnauthorized() } }
    }

    // ---- ingest --------------------------------------------------------------------------------

    private fun event(agent: Agent, payload: String) = HostEnvelope(
        kind = MessageKind.EVENT,
        type = EventType.ACTIVITY,
        agentId = agent.id,
        payload = objectMapper.readTree(payload),
    )

    @Test
    fun `a host reporting an incident has it stored with its severity`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(
            checkNotNull(host.id),
            event(agent, """{"scope":"system","severity":"warning","text":"Kicked: flying"}"""),
        )

        val stored = activityEntryRepository.findAll().single()
        assertEquals(ActivityScope.SYSTEM, stored.scope)
        assertEquals(ActivitySeverity.WARNING, stored.severity)
        assertEquals("Kicked: flying", stored.text)
    }

    /** A host that reports what happened without rating it still gets the line recorded. */
    @Test
    fun `a missing severity is read as info rather than dropping the line`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(
            checkNotNull(host.id),
            event(agent, """{"scope":"lifecycle","text":"Connected"}"""),
        )

        assertEquals(ActivitySeverity.INFO, activityEntryRepository.findAll().single().severity)
    }

    @Test
    fun `a scope the backend does not know is dropped`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(checkNotNull(host.id), event(agent, """{"scope":"weather","text":"rain"}"""))

        assertEquals(0, activityEntryRepository.count())
    }

    @Test
    fun `a host cannot report an incident for an agent it does not own`() {
        val agent = createAgent("Mason_01", reachableHost("host-a"))
        val intruder = reachableHost("host-b")

        hostReports.onMessage(
            checkNotNull(intruder.id),
            event(agent, """{"scope":"system","text":"not yours"}"""),
        )

        assertEquals(0, activityEntryRepository.count())
    }

    // ---- retention -----------------------------------------------------------------------------

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `the purge drops activity past its retention and keeps the rest`() {
        activityEntryRepository.deleteAll()
        val host = hostRepository.saveAndFlush(net.integr.osmium.host.model.Host(name = "purge-host-2", tokenHash = "h"))
        val agent = createAgent("Mason_purge", host)

        val stale = incident(agent, "old", at = Instant.now().minus(11, ChronoUnit.DAYS))
        val fresh = incident(agent, "new", at = Instant.now().minus(9, ChronoUnit.DAYS))

        activityService.purgeExpired()

        val remaining = activityEntryRepository.findAll().map { it.id }
        assertEquals(listOf(fresh.id), remaining)
        assertTrue(stale.id !in remaining)

        activityEntryRepository.deleteAll()
        agentRepository.deleteById(checkNotNull(agent.id))
        hostRepository.deleteById(checkNotNull(host.id))
    }
}

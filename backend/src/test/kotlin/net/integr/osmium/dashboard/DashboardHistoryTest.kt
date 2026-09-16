package net.integr.osmium.dashboard

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildJobState
import net.integr.osmium.build.model.BuildSegment
import net.integr.osmium.dashboard.service.DashboardHistory
import net.integr.osmium.host.model.Host
import net.integr.osmium.hostlink.HostTraffic
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.test.web.servlet.get
import java.time.Duration
import java.time.Instant
import kotlin.test.assertEquals

class DashboardHistoryTest : AbstractRestTest() {

    @Autowired private lateinit var history: DashboardHistory
    @Autowired private lateinit var traffic: HostTraffic

    private val now = Instant.parse("2026-09-16T12:00:00Z")

    private fun job(state: BuildJobState, total: Long, placed: Long, minutesAgo: Long) =
        BuildJob(state = state, totalBlocks = total, startedAt = now.minus(Duration.ofMinutes(minutesAgo))).apply {
            segments += BuildSegment(blocksPlaced = placed)
        }

    @Test
    fun `a reading counts only reachable agents in game and only unfinished work`() {
        val live = Host(name = "live", lastSeenAt = now)
        val cold = Host(name = "cold")
        val agents = listOf(
            Agent(label = "a", host = live, state = AgentState.ONLINE),
            Agent(label = "b", host = cold, state = AgentState.ONLINE),
            Agent(label = "c", host = live, state = AgentState.LINKED),
        )
        val jobs = listOf(
            job(BuildJobState.ACTIVE, total = 1_000, placed = 300, minutesAgo = 10),
            job(BuildJobState.PAUSED, total = 500, placed = 100, minutesAgo = 60),
        )

        val reading = DashboardHistory.reading(agents, jobs, now)

        assertEquals(1, reading.online)
        assertEquals(3, reading.agents)
        assertEquals(400, reading.placed)
        assertEquals(1_500, reading.total)
        // A paused job's blocks count as placed, but its minutes are not minutes anyone worked.
        assertEquals(30, reading.perMinute)
    }

    @Test
    fun `a job seconds old has no rate yet`() {
        val reading = DashboardHistory.reading(emptyList(), listOf(job(BuildJobState.ACTIVE, 10, 5, 0)), now)
        assertEquals(0, reading.perMinute)
    }

    @Test
    fun `link rates start at zero and then follow the running totals`() {
        val first = DashboardHistory.linkRates(emptyMap(), mapOf(1L to (5_000L to 9_000L)), null)
        assertEquals(0L to 0L, first[1])

        val next = DashboardHistory.linkRates(
            mapOf(1L to (5_000L to 9_000L)),
            mapOf(1L to (6_000L to 29_000L)),
            Duration.ofSeconds(10),
        )
        assertEquals(100L to 2_000L, next[1])
    }

    @Test
    fun `a sample is served per server and per host`() {
        val host = reachableHost("dash-host")
        createAgent("Dash_01", host, AgentState.ONLINE, server = "one.example.com")
        createAgent("Dash_02", host, AgentState.LINKED, server = "two.example.com")
        traffic.reported(host.id!!, sent = 0, received = 0)

        history.sample()

        val auth = authAs("dash-viewer", RoleNames.VIEWER)

        mockMvc.get("/api/dashboard/history") { header("Authorization", auth) }
            .andExpect {
                status { isOk() }
                jsonPath("$[-1].fleet.online") { value(1) }
                jsonPath("$[-1].fleet.agents") { value(2) }
                jsonPath("$[-1].servers['one.example.com'].online") { value(1) }
                jsonPath("$[-1].servers['two.example.com'].online") { value(0) }
                jsonPath("$[-1].hosts[?(@.name == 'dash-host')].reachable") { value(true) }
                jsonPath("$[-1].hosts[?(@.name == 'dash-host')].gameSent") { value(0) }
            }
    }

    @Test
    fun `history needs agent read`() {
        val auth = authAs("dash-nobody")

        mockMvc.get("/api/dashboard/history") { header("Authorization", auth) }
            .andExpect { status { isForbidden() } }
    }
}

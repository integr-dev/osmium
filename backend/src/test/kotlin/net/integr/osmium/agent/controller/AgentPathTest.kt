package net.integr.osmium.agent.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.dto.AgentPathResponse
import net.integr.osmium.agent.dto.AgentPathState
import net.integr.osmium.agent.dto.PathGoalResponse
import net.integr.osmium.agent.dto.PositionResponse
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.service.AgentPathStore
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post

/**
 * The path endpoints.
 *
 * Three things they are careful about, and each one is a decision that could plausibly have gone the
 * other way:
 *
 * - **A journey is never stored.** An old position is still the only answer there is about where
 *   somebody was; an old path is simply wrong about where somebody is going. So the store holds a
 *   journey for exactly as long as it lasts, and a page opened afterwards draws nothing.
 * - **Reading is the fleet's, not one agent's.** A map draws every agent in a world, and one request
 *   per agent to learn that most of them are standing still is a request per agent too many.
 * - **Stopping is never refused.** Sending an agent somewhere is refused while it is building; the
 *   command that calls it back must not be, or the state an operator most wants out of is the one
 *   they cannot leave.
 */
class AgentPathTest : AbstractRestTest() {

    @Autowired private lateinit var pathStore: AgentPathStore

    @BeforeEach
    fun clearPaths() {
        // In-memory and shared across the context, so a journey left by another test would be read
        // as one of this test's own.
        for (path in pathStore.all()) pathStore.forget(path.agentId)
    }

    private fun walking(agentId: Long) = AgentPathResponse(
        agentId = agentId,
        state = AgentPathState.MOVING,
        dimension = "overworld",
        goal = PathGoalResponse(128.0, 64.0, -340.0),
        nodes = listOf(PositionResponse(0.5, 64.0, 0.5), PositionResponse(1.5, 64.0, 0.5)),
        progress = 0,
        reason = null,
    )

    @Test
    fun `a journey in progress is listed`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Walker_1", host = reachableHost(), state = AgentState.ONLINE)
        pathStore.record(walking(agent.id!!))

        mockMvc.get("/api/agents/paths") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].agentId") { value(agent.id!!.toInt()) }
            jsonPath("$[0].state") { value("MOVING") }
            jsonPath("$[0].dimension") { value("overworld") }
            jsonPath("$[0].goal.x") { value(128.0) }
            jsonPath("$[0].nodes.length()") { value(2) }
        }
    }

    /**
     * The literal segment has to win over `/{id}`, or this reads as a request for the agent named
     * "paths" and answers 400.
     */
    @Test
    fun `the fleet listing is not read as an agent id`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)

        mockMvc.get("/api/agents/paths") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.length()") { value(0) }
        }
    }

    @Test
    fun `reading journeys needs permission`() {
        mockMvc.get("/api/agents/paths").andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `sending an agent somewhere refuses one that is not in the game`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // A route is about the world the agent is standing in. One held for a session that has not
        // started would be walked in whichever world it eventually joins.
        val agent = createAgent(label = "Walker_2", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.post("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"waypoints":[{"x":128,"y":64,"z":-340}]}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `sending an agent nowhere is refused`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // Nothing means going nowhere, which nobody means. Accepted and dispatched, it would look
        // to an operator exactly like a command the host never got.
        val agent = createAgent(label = "Walker_3", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"waypoints":[]}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `sending an agent reaches delivery for one whose host is not there`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // 503 rather than 409: a legitimate request about an agent in the game, stopped by nothing
        // listening on the other side.
        val agent = createAgent(label = "Walker_4", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"waypoints":[{"x":128,"y":64,"z":-340}]}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

    /**
     * A destination picked off a part of the map nobody has charted has no height to give, and the
     * agent is to reach that column at whatever height the ground turns out to be. Reaching delivery
     * is the proof it got past validation - the host is what is not there.
     */
    @Test
    fun `a waypoint may name a column rather than a point`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Walker_7", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"waypoints":[{"x":128,"z":-340}]}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

    /** Jackson reads an explicit null into the same absent height, which is the same instruction. */
    @Test
    fun `a null height is read the same way an absent one is`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Walker_8", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"waypoints":[{"x":128,"y":null,"z":-340}]}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

    /** X and Z are not optional: a waypoint with neither names nowhere at all. */
    @Test
    fun `a waypoint still needs the two coordinates that are not optional`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Walker_9", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"waypoints":[{"y":64}]}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `stopping refuses an agent that is not in the game`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Walker_5", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.delete("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `walking an agent needs the authority that runs one`() {
        // `agent.read` is enough to watch a journey and not enough to start one.
        val auth = authAs("rory", RoleNames.VIEWER)
        val agent = createAgent(label = "Walker_6", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/path") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"waypoints":[{"x":1,"y":2,"z":3}]}"""
        }.andExpect {
            status { isForbidden() }
        }
    }
}

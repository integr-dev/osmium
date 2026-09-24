package net.integr.osmium.build

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.host.model.Host
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.ResultActionsDsl
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post

/**
 * Region plans and the jobs of them: a box emptied, and a footprint charted.
 *
 * What is worth testing is what makes these *different* from a build, since everything else - the
 * pool, the scheduler, pausing, releasing - is the code the build tests already cover. Which is
 * four things: the plan is two corners rather than a file, the pieces are cut out of the box
 * itself, their dependency points the other way, and the server comes from the plan rather than
 * from whoever happens to be ticked.
 */
class RegionJobControllerTest : AbstractRestTest() {

    private val tokens = mutableMapOf<String, String>()

    private fun asRole(role: String): String = tokens.getOrPut(role) { authAs("digger-$role", role) }

    private fun onlineAgent(label: String, host: Host, server: String = "mc.example.com"): Agent =
        createAgent(label = label, host = host, state = AgentState.ONLINE, server = server)

    private fun create(
        name: String = "the pit",
        type: String = "EXCAVATE",
        from: Triple<Int, Int, Int> = Triple(0, 60, 0),
        to: Triple<Int, Int, Int> = Triple(7, 63, 7),
        server: String = "mc.example.com",
        rising: Boolean = false,
        user: String = RoleNames.ORCHESTRATOR,
    ): ResultActionsDsl = mockMvc.post("/api/regions") {
        header(HttpHeaders.AUTHORIZATION, asRole(user))
        contentType = MediaType.APPLICATION_JSON
        content = """{"name":"$name","type":"$type",""" +
            """"from":{"x":${from.first},"y":${from.second},"z":${from.third}},""" +
            """"to":{"x":${to.first},"y":${to.second},"z":${to.third}},""" +
            """"rising":$rising,""" +
            """"serverAddress":"$server","dimension":"overworld"}"""
    }

    /** The id of a region made for a test that is about something else. */
    private fun region(
        name: String = "the pit",
        type: String = "EXCAVATE",
        from: Triple<Int, Int, Int> = Triple(0, 60, 0),
        to: Triple<Int, Int, Int> = Triple(7, 63, 7),
        server: String = "mc.example.com",
        rising: Boolean = false,
    ): Int {
        val body = create(name = name, type = type, from = from, to = to, server = server, rising = rising)
            .andReturn().response.contentAsString
        return JsonPath.read(body, "$.id")
    }

    private fun start(
        regionId: Int,
        agentIds: List<Long>,
        mode: String = "GRID",
        parts: Int? = null,
        user: String = RoleNames.ORCHESTRATOR,
    ): ResultActionsDsl = mockMvc.post("/api/regions/$regionId/jobs") {
        header(HttpHeaders.AUTHORIZATION, asRole(user))
        contentType = MediaType.APPLICATION_JSON
        content = """{"mode":"$mode","agentIds":[${agentIds.joinToString(",")}]""" +
            (parts?.let { ""","parts":$it""" } ?: "") + "}"
    }

    @Test
    fun `a region is two corners, kept as a half-open box`() {
        create().andExpect {
            status { isCreated() }
            jsonPath("$.type") { value("EXCAVATE") }
            jsonPath("$.name") { value("the pit") }
            // The corners are inclusive, so the far one is one past what was typed.
            jsonPath("$.placement.x") { value(0) }
            jsonPath("$.placement.y") { value(60) }
            jsonPath("$.regionMax.x") { value(8) }
            jsonPath("$.regionMax.y") { value(64) }
            jsonPath("$.size.x") { value(8) }
            jsonPath("$.blocks") { value(8 * 4 * 8) }
            jsonPath("$.serverAddress") { value("mc.example.com") }
            jsonPath("$.dimension") { value("overworld") }
        }
    }

    @Test
    fun `corners may be given either way round`() {
        create(from = Triple(7, 63, 7), to = Triple(0, 60, 0)).andExpect {
            status { isCreated() }
            jsonPath("$.placement.x") { value(0) }
            jsonPath("$.regionMax.x") { value(8) }
        }
    }

    /** Mapping is flat work: the lower Y is the height its agents fly, and the box is that thick. */
    @Test
    fun `a survey is one block thick at the height the agents fly`() {
        create(name = "the valley", type = "MAP", from = Triple(-100, 90, -100), to = Triple(99, 120, 99))
            .andExpect {
                status { isCreated() }
                jsonPath("$.placement.y") { value(90) }
                jsonPath("$.regionMax.y") { value(91) }
                jsonPath("$.height") { value(90) }
                jsonPath("$.blocks") { value(200 * 200) }
            }
    }

    /**
     * A flat flight is only flat where the ground is, so a survey can say that the height it was
     * given is the lowest one and that the crew lifts over whatever stands in the way.
     *
     * The box does not change: it is still the one-block slab every reader of a region already
     * understands, and the height is still where the flight starts and settles back to.
     */
    @Test
    fun `a survey can be told to climb over what is in the way`() {
        create(
            name = "the valley",
            type = "MAP",
            from = Triple(-100, 90, -100),
            to = Triple(99, 90, 99),
            rising = true,
        ).andExpect {
            status { isCreated() }
            jsonPath("$.rising") { value(true) }
            jsonPath("$.height") { value(90) }
            jsonPath("$.regionMax.y") { value(91) }
        }
    }

    /** A hole is dug out rather than flown over, so there is nothing for an excavation to climb. */
    @Test
    fun `an excavation is never told to climb, whatever it is sent`() {
        create(rising = true).andExpect {
            status { isCreated() }
            jsonPath("$.rising") { value(false) }
        }
    }

    /** Pinned with the box: how a crew in the air is flying is not an edit to the plan away. */
    @Test
    fun `a job of a climbing survey carries it, and a later edit does not reach the job`() {
        val host = reachableHost()
        val scout = onlineAgent("Scout_01", host)
        val id = region(name = "the valley", type = "MAP", from = Triple(0, 90, 0), to = Triple(31, 90, 31), rising = true)

        val job = start(id, listOf(scout.id!!)).andExpect {
            status { isCreated() }
            jsonPath("$.rising") { value(true) }
        }.andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(job, "$.id")

        mockMvc.patch("/api/regions/$id") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"rising":false}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.rising") { value(false) }
        }

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.rising") { value(true) }
        }
    }

    /**
     * A plan can be written before anybody has been out to measure it, exactly as a build plan can
     * be saved unplaced. What that costs is the ability to start it, which is checked at the start.
     */
    @Test
    fun `a region can be written with no corners and no server`() {
        mockMvc.post("/api/regions") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"somewhere north","type":"EXCAVATE"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.placed") { value(false) }
            jsonPath("$.placement") { doesNotExist() }
            jsonPath("$.serverAddress") { doesNotExist() }
        }
    }

    @Test
    fun `an unplaced region cannot be worked`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)

        val body = mockMvc.post("/api/regions") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"somewhere north","type":"EXCAVATE"}"""
        }.andReturn().response.contentAsString
        val id: Int = JsonPath.read(body, "$.id")

        start(id, listOf(one.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `a region with corners but no server cannot be worked either`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)

        val body = mockMvc.post("/api/regions") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"somewhere north","type":"EXCAVATE",""" +
                """"from":{"x":0,"y":60,"z":0},"to":{"x":7,"y":63,"z":7}}"""
        }.andReturn().response.contentAsString
        val id: Int = JsonPath.read(body, "$.id")

        start(id, listOf(one.id!!)).andExpect { status { isConflict() } }
    }

    /** Blank clears it, as it does on a build plan: JSON cannot tell absent from null. */
    @Test
    fun `a region can be unplaced again, and its server taken off`() {
        val id = region()

        mockMvc.patch("/api/regions/$id") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"unplace":true,"serverAddress":"  "}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.placed") { value(false) }
            jsonPath("$.serverAddress") { doesNotExist() }
        }
    }

    @Test
    fun `both corners move together or neither does`() {
        val id = region()

        mockMvc.patch("/api/regions/$id") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"from":{"x":10,"y":10,"z":10}}"""
        }.andExpect { status { isConflict() } }
    }

    @Test
    fun `a region past the size limit is refused by the form that took it`() {
        create(from = Triple(0, 0, 0), to = Triple(999, 255, 999)).andExpect { status { isConflict() } }
    }

    @Test
    fun `a job of a region divides the box it was written for`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)
        val two = onlineAgent("Digger_02", host)
        val id = region()

        start(id, listOf(one.id!!, two.id!!)).andExpect {
            status { isCreated() }
            jsonPath("$.type") { value("EXCAVATE") }
            jsonPath("$.name") { value("the pit") }
            jsonPath("$.regionId") { value(id) }
            // No plan of the other kind, and no file behind it.
            jsonPath("$.buildId") { doesNotExist() }
            jsonPath("$.schematicId") { doesNotExist() }
            jsonPath("$.dimension") { value("overworld") }
            jsonPath("$.placement.x") { value(0) }
            jsonPath("$.regionMax.x") { value(8) }
            jsonPath("$.totalBlocks") { value(8 * 4 * 8) }
            jsonPath("$.segments.length()") { value(2) }
        }
    }

    @Test
    fun `digging waits for the roof, where building waits for the floor`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)
        val two = onlineAgent("Digger_02", host)
        // A column: the only shape where the cut has to be on height, so the two pieces are
        // genuinely one above the other.
        val id = region(from = Triple(0, 60, 0), to = Triple(0, 67, 0))

        start(id, listOf(one.id!!, two.id!!)).andExpect {
            status { isCreated() }
            // Piece 1 is the roof, and nothing is over it.
            jsonPath("$.segments[0].minY") { value(64) }
            jsonPath("$.segments[0].blockedBy.length()") { value(0) }
            // Piece 2 is under it, and waits for it.
            jsonPath("$.segments[1].minY") { value(60) }
            jsonPath("$.segments[1].blockedBy[0]") { value(1) }
            // So only the roof goes out, however many agents are standing about.
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[1].state") { value("PENDING") }
        }
    }

    @Test
    fun `an excavation is dug from the top down unless told otherwise`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)

        start(region(), listOf(one.id!!)).andExpect {
            status { isCreated() }
            jsonPath("$.segments[0].placementOrder") { value("y-z+x+") }
        }
    }

    @Test
    fun `a survey goes out all at once, in strips`() {
        val host = reachableHost()
        val one = onlineAgent("Scout_01", host)
        val two = onlineAgent("Scout_02", host)
        val id = region(name = "the valley", type = "MAP", from = Triple(-100, 90, -100), to = Triple(99, 90, 99))

        start(id, listOf(one.id!!, two.id!!)).andExpect {
            status { isCreated() }
            jsonPath("$.type") { value("MAP") }
            // Strips whatever was asked for: a slab one block thick has no height to cut.
            jsonPath("$.splitMode") { value("COLUMNS") }
            jsonPath("$.totalBlocks") { value(200 * 200) }
            // Flat work, so nothing stands on anything.
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[1].state") { value("ASSIGNED") }
        }
    }

    /**
     * The rule that parts company with a build job, which takes its server from its crew: a box
     * typed against one world's landscape must not be dug in another because somebody ticked a
     * different agent.
     */
    @Test
    fun `the server comes from the region, and a crew somewhere else is refused`() {
        val host = reachableHost()
        val elsewhere = onlineAgent("Digger_02", host, server = "other.example.com")

        start(region(), listOf(elsewhere.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `a crew from two servers is refused, as it is for a build`() {
        val host = reachableHost()
        val here = onlineAgent("Digger_01", host)
        val elsewhere = onlineAgent("Digger_02", host, server = "other.example.com")

        start(region(), listOf(here.id!!, elsewhere.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `one live job per region per server`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)
        val two = onlineAgent("Digger_02", host)
        val id = region()

        start(id, listOf(one.id!!)).andExpect { status { isCreated() } }
        start(id, listOf(two.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `an agent already on a job is not quietly taken off it`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)

        start(region(name = "first hole"), listOf(one.id!!)).andExpect { status { isCreated() } }
        start(region(name = "second hole"), listOf(one.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `a region being worked cannot be deleted`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)
        val id = region()

        start(id, listOf(one.id!!)).andExpect { status { isCreated() } }

        mockMvc.delete("/api/regions/$id") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isConflict() } }
    }

    /**
     * The preview is the same call the start makes, which is the only reason it is worth having:
     * what an operator looks at has to be what the agents are given.
     */
    @Test
    fun `a region can be divided without starting anything`() {
        // A column, so the only axis with room to cut is the one that carries the order.
        val id = region(from = Triple(0, 60, 0), to = Triple(0, 67, 0))

        mockMvc.post("/api/regions/$id/split") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.VIEWER))
            contentType = MediaType.APPLICATION_JSON
            content = """{"mode":"GRID","parts":2}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.parts") { value(2) }
            jsonPath("$.blocks") { value(8) }
            // Numbered from the roof down, as the excavation itself would be.
            jsonPath("$.segments[0].minY") { value(64) }
        }

        mockMvc.get("/api/regions/$id") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.VIEWER))
        }.andExpect { status { isOk() } }
    }

    @Test
    fun `writing a region needs the node that dispatches the fleet`() {
        create(user = RoleNames.VIEWER).andExpect { status { isForbidden() } }
    }

    @Test
    fun `starting one needs it too`() {
        val host = reachableHost()
        val one = onlineAgent("Digger_01", host)

        start(region(), listOf(one.id!!), user = RoleNames.VIEWER).andExpect { status { isForbidden() } }
    }
}

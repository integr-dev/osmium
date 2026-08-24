package net.integr.osmium.build

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.build.model.Build
import net.integr.osmium.build.model.BuildSubstitution
import net.integr.osmium.build.repository.BuildRepository
import net.integr.osmium.host.model.Host
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostReportService
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.schematic.Cell
import net.integr.osmium.schematic.model.Schematic
import net.integr.osmium.schematic.model.SchematicStatus
import net.integr.osmium.schematic.repository.SchematicIndexRepository
import net.integr.osmium.schematic.repository.SchematicRepository
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.ResultActionsDsl
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post
import tools.jackson.databind.ObjectMapper
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Build jobs: a plan frozen and handed out.
 *
 * The interesting cases are all about the freeze. A job copies the anchor, the substitutions and
 * the schematic it was divided from, and the point of every one of those copies is that editing the
 * plan afterwards changes the *next* job rather than the one agents are carrying out.
 *
 * Nothing here dispatches. Segments are assigned and stay assigned, because carrying one to a host
 * needs a wire message that does not exist yet.
 */
class BuildJobControllerTest : AbstractRestTest() {

    @Autowired private lateinit var schematics: SchematicRepository
    @Autowired private lateinit var builds: BuildRepository
    @Autowired private lateinit var index: SchematicIndexRepository
    @Autowired private lateinit var auditEntries: AuditEntryRepository
    @Autowired private lateinit var hostReports: HostReportService
    @Autowired private lateinit var objectMapper: ObjectMapper

    private val tokens = mutableMapOf<String, String>()

    private fun asRole(role: String): String = tokens.getOrPut(role) { authAs("runner-$role", role) }

    /**
     * A schematic with a real occupancy index: four cells in a row, ten blocks each.
     *
     * Seeded directly rather than uploaded. The split reads the index and nothing else, so a real
     * file would only add a decoder to the things that could fail in a test about dispatching.
     */
    private fun readySchematic(name: String = "cathedral"): Schematic {
        val schematic = schematics.saveAndFlush(
            Schematic(
                name = name,
                originalFilename = "$name.litematic",
                sizeBytes = 1,
                receivedBytes = 1,
                status = SchematicStatus.READY,
                uploadedBy = "root",
                originX = 0,
                originY = 0,
                originZ = 0,
                cellSize = 1,
                sizeX = 4,
                sizeY = 1,
                sizeZ = 1,
                blockCount = 40,
            ),
        )
        index.replaceCells(
            schematic.id!!,
            (0..3).map { x -> Cell(x, 0, 0, 10, "stone") },
        )
        return schematic
    }

    private fun placedBuild(
        schematic: Schematic = readySchematic(),
        name: String = "north tower",
        substitutions: List<Pair<String, String?>> = listOf("diamond_block" to "stone"),
    ): Build {
        val build = Build(
            schematic = schematic,
            name = name,
            placeX = 100,
            placeY = 64,
            placeZ = -30,
            createdBy = "root",
        )
        substitutions.forEach { (from, to) ->
            build.substitutions += BuildSubstitution(build = build, from = from, to = to)
        }
        return builds.saveAndFlush(build)
    }

    private fun onlineAgent(label: String, host: Host, server: String = "mc.example.com:25565"): Agent =
        createAgent(label = label, host = host, state = AgentState.ONLINE, server = server)

    private fun start(
        buildId: Long,
        agentIds: List<Long>,
        mode: String = "COLUMNS",
        user: String = RoleNames.ORCHESTRATOR,
    ): ResultActionsDsl = mockMvc.post("/api/builds/$buildId/jobs") {
        header(HttpHeaders.AUTHORIZATION, asRole(user))
        contentType = MediaType.APPLICATION_JSON
        content = """{"mode":"$mode","agentIds":[${agentIds.joinToString(",")}]}"""
    }

    private fun pause(jobId: Int): ResultActionsDsl = mockMvc.post("/api/jobs/$jobId/pause") {
        header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
    }

    /**
     * A state change as the host reports one, rather than a row edited behind the service’s back.
     *
     * The reassignment being tested hangs off that report, so writing the state straight into the
     * repository would test nothing but the repository.
     */
    private fun reports(agent: Agent, state: AgentState) = hostReports.onMessage(
        checkNotNull(agent.host.id),
        HostEnvelope(
            kind = MessageKind.EVENT,
            type = EventType.AGENT_STATUS,
            agentId = agent.id,
            payload = objectMapper.readTree("""{"state":"${state.name}"}"""),
        ),
    )

    @Test
    fun `a job freezes the plan, divides it, and hands every piece to an agent`() {
        val host = reachableHost()
        val build = placedBuild()
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        start(build.id!!, listOf(one.id!!, two.id!!)).andExpect {
            status { isCreated() }
            jsonPath("$.state") { value("ACTIVE") }
            jsonPath("$.buildName") { value("north tower") }
            jsonPath("$.serverAddress") { value("mc.example.com:25565") }
            jsonPath("$.totalBlocks") { value(40) }
            jsonPath("$.blocksPlaced") { value(0) }
            jsonPath("$.requestedParts") { value(2) }
            jsonPath("$.segments.length()") { value(2) }

            // The anchor is where the schematic's minimum corner lands, and the split works in the
            // schematic's own coordinates. What the host is told is the sum of the two, once.
            jsonPath("$.placement.x") { value(100) }
            jsonPath("$.segments[0].minX") { value(100) }
            jsonPath("$.segments[0].minY") { value(64) }
            jsonPath("$.segments[0].minZ") { value(-30) }
            // Half-open: 102 is the first block that is *not* in the first segment.
            jsonPath("$.segments[0].maxX") { value(102) }
            jsonPath("$.segments[1].minX") { value(102) }
            jsonPath("$.segments[1].maxX") { value(104) }

            jsonPath("$.segments[0].ordinal") { value(1) }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
            jsonPath("$.segments[1].agentLabel") { value("Mason_02") }
            jsonPath("$.segments[0].blocks") { value(20) }
            jsonPath("$.segments[0].sharePercent") { value(50) }
            jsonPath("$.segments[0].blocksPlaced") { value(0) }
            jsonPath("$.segments[0].lastReportAt") { value(null) }

            // A copy of the plan's rules, taken at the moment Start was pressed.
            jsonPath("$.substitutions.length()") { value(1) }
            jsonPath("$.substitutions[0].from") { value("diamond_block") }
        }

        val recorded = auditEntries.findAll().filter { it.action == AuditAction.BUILD_JOB_START }
        assertEquals(1, recorded.size)
        assertTrue(recorded.single().detail!!.contains("Mason_01"))
    }

    @Test
    fun `editing the plan under a live job does not change what is being built`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )

        // Somebody moves the plan and rewrites its rules while agents are placing blocks from it.
        mockMvc.patch("/api/builds/${build.id}") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"placement":{"x":-500,"y":10,"z":-500},"substitutions":[]}"""
        }.andExpect { status { isOk() } }

        // The job is unmoved, and still carries the rule the plan no longer has. This is the whole
        // reason a job exists as a row rather than as a view over the plan.
        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.placement.x") { value(100) }
            jsonPath("$.segments[0].minX") { value(100) }
            jsonPath("$.substitutions.length()") { value(1) }
        }
    }

    @Test
    fun `a plan with nowhere to stand cannot be job`() {
        val host = reachableHost()
        val unplaced = builds.saveAndFlush(
            Build(schematic = readySchematic(), name = "floating", createdBy = "root"),
        )
        val agent = onlineAgent("Mason_01", host)

        start(unplaced.id!!, listOf(agent.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `agents on two servers cannot share a job`() {
        val host = reachableHost()
        val build = placedBuild()
        val here = onlineAgent("Mason_01", host, server = "mc.example.com:25565")
        val elsewhere = onlineAgent("Mason_02", host, server = "other.example.com:25565")

        // One job is one world. Two servers is two jobs, which is what makes the per-server
        // arithmetic on the dashboard unnecessary rather than merely wrong.
        start(build.id!!, listOf(here.id!!, elsewhere.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `an agent that is not in game cannot be given work`() {
        val host = reachableHost()
        val build = placedBuild()
        val linked = createAgent("Mason_01", host, state = AgentState.LINKED)

        start(build.id!!, listOf(linked.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `an agent whose host has gone quiet is not somewhere to send work`() {
        val cold = unreachableHost()
        val build = placedBuild()
        // Believed ONLINE, but nothing has heartbeated: the derived state is STALE, and dispatching
        // to it would 503 at the socket anyway.
        val stale = onlineAgent("Mason_01", cold)

        start(build.id!!, listOf(stale.id!!)).andExpect { status { isConflict() } }
    }

    @Test
    fun `one build is built once per server, and not twice on one`() {
        val host = reachableHost()
        val build = placedBuild()
        val here = onlineAgent("Mason_01", host, server = "mc.example.com:25565")
        val alsoHere = onlineAgent("Mason_02", host, server = "mc.example.com:25565")
        val elsewhere = onlineAgent("Mason_03", host, server = "other.example.com:25565")

        start(build.id!!, listOf(here.id!!)).andExpect { status { isCreated() } }

        // The same tower on two servers is the case a job exists to allow — it is the reason a
        // build is its own row rather than columns on the schematic.
        start(build.id!!, listOf(elsewhere.id!!)).andExpect { status { isCreated() } }

        // Twice on one server is two sets of agents placing the same blocks in the same place.
        start(build.id!!, listOf(alsoHere.id!!)).andExpect { status { isConflict() } }
    }

    /**
     * The hole behind that: pausing let a second job in beside the first, and resuming then put two
     * crews on one set of blocks. A paused job is not finished — it keeps its segments so it can be
     * resumed — so it keeps its claim on the server too.
     */
    @Test
    fun `a paused job still holds its server`() {
        val host = reachableHost()
        val build = placedBuild()
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(one.id!!)).andReturn().response.contentAsString,
            "$.id",
        )
        pause(jobId).andExpect { status { isOk() } }

        start(build.id!!, listOf(two.id!!)).andExpect { status { isConflict() } }

        // Deleting it is what gives the server back, the same act that gives the crew back.
        mockMvc.delete("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isNoContent() } }

        start(build.id!!, listOf(two.id!!)).andExpect { status { isCreated() } }
    }

    @Test
    fun `an agent cannot build two things at once`() {
        val host = reachableHost()
        val first = placedBuild(name = "north tower")
        val second = placedBuild(schematic = readySchematic("chapel"), name = "south tower")
        val agent = onlineAgent("Mason_01", host)

        start(first.id!!, listOf(agent.id!!)).andExpect { status { isCreated() } }
        start(second.id!!, listOf(agent.id!!)).andExpect { status { isConflict() } }
    }

    /**
     * The bug this exists to prevent: cancelling leaves the segments where they were, so the record
     * still says who was on what — and every one of those rows went on claiming its agent. An
     * operator who cancelled a job was told each of its builders "is already building something"
     * and could never start another one.
     */
    @Test
    fun `a paused job keeps its crew, and deleting it gives them back`() {
        val host = reachableHost()
        val first = placedBuild(name = "north tower")
        val second = placedBuild(schematic = readySchematic("chapel"), name = "south tower")
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(first.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )
        pause(jobId).andExpect { status { isOk() } }

        // Paused means somebody intends to come back to it, so the crew is still on it. Offering
        // the agent elsewhere would make resuming a reassignment of everybody.
        start(second.id!!, listOf(agent.id!!)).andExpect { status { isConflict() } }

        // Deleting the job is what says they are not coming back.
        mockMvc.delete("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isNoContent() } }

        start(second.id!!, listOf(agent.id!!)).andExpect { status { isCreated() } }
    }

    @Test
    fun `a paused job resumes exactly where it stopped`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )
        pause(jobId).andExpect {
            status { isOk() }
            jsonPath("$.state") { value("PAUSED") }
            // Nothing was given up: not the assignment, not the counts, and not a finishing time,
            // which a paused job does not have because it has not finished.
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
            jsonPath("$.finishedAt") { value(null) }
        }

        mockMvc.post("/api/jobs/$jobId/resume") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.state") { value("ACTIVE") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
        }

        val trail = auditEntries.findAll().map { it.action }
        assertTrue(trail.contains(AuditAction.BUILD_JOB_PAUSE))
        assertTrue(trail.contains(AuditAction.BUILD_JOB_RESUME))
    }

    @Test
    fun `an active job cannot be resumed`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )

        mockMvc.post("/api/jobs/$jobId/resume") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isConflict() } }
    }

    /**
     * One bot cannot be in two places. The version that looks reasonable in an interface is two
     * segments of the *same* build, which is the same impossibility with a shorter walk.
     */
    @Test
    fun `an agent cannot hold two segments of one build`() {
        val host = reachableHost()
        val build = placedBuild()
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(one.id!!, two.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val second: Int = JsonPath.read(body, "$.segments[1].id")

        // Mason_01 already has segment 1 of this very job.
        mockMvc.post("/api/jobs/$jobId/segments/$second/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"agentId":${one.id}}"""
        }.andExpect { status { isConflict() } }
    }
    @Test
    fun `the same agent cannot be listed twice to make up the numbers`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        start(build.id!!, listOf(agent.id!!, agent.id!!)).andExpect { status { isBadRequest() } }
    }

    @Test
    fun `releasing a segment returns it to the pool rather than blaming anyone for it`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("PENDING") }
            jsonPath("$.segments[0].agentId") { value(null) }
            jsonPath("$.segments[0].agentLabel") { value(null) }
            jsonPath("$.segments[0].failureReason") { value(null) }
        }

        // ...and it can be picked up again, by the same agent or another one.
        mockMvc.post("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"agentId":${agent.id}}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
        }
    }

    @Test
    fun `removing an agent frees what it was holding instead of stranding it`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )

        mockMvc.delete("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isNoContent() } }

        // The foreign key would have left the segment assigned to a null: live work with no owner,
        // which no interface can offer to hand to anybody else.
        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("PENDING") }
            jsonPath("$.segments[0].agentId") { value(null) }
        }
    }

    @Test
    fun `a plan being built cannot be deleted, and can be once the job is paused`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )

        mockMvc.delete("/api/builds/${build.id}") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isConflict() } }

        mockMvc.post("/api/jobs/$jobId/pause") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.state") { value("PAUSED") }
            // No finishing time: a paused job has stopped, not finished.
            jsonPath("$.finishedAt") { value(null) }
            // Pausing stops the work; it does not un-place blocks or forget who was on what.
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
        }

        mockMvc.delete("/api/builds/${build.id}") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isNoContent() } }
    }

    @Test
    fun `a schematic being built can be neither removed nor read again`() {
        val host = reachableHost()
        val schematic = readySchematic()
        val build = placedBuild(schematic = schematic)
        val agent = onlineAgent("Mason_01", host)

        start(build.id!!, listOf(agent.id!!)).andExpect { status { isCreated() } }

        mockMvc.delete("/api/schematics/${schematic.id}") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isConflict() } }

        // Re-analysis matters as much as deletion and looks harmless: it rewrites the occupancy
        // index the segments were cut out of, leaving boxes whose block counts describe a grid that
        // is no longer there.
        mockMvc.post("/api/schematics/${schematic.id}/reanalyse") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isConflict() } }
    }

    @Test
    fun `a job cannot be paused twice`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )

        val pause = {
            mockMvc.post("/api/jobs/$jobId/pause") {
                header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            }
        }
        pause().andExpect { status { isOk() } }
        pause().andExpect { status { isConflict() } }
    }

    @Test
    fun `a live job cannot be cleared away, and a paused one can`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )

        val remove = {
            mockMvc.delete("/api/jobs/$jobId") {
                header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
            }
        }

        // Cancelling and removing are two acts. Collapsing them would let one click take a live job
        // and its assignments off the screen with nothing to say what became of them.
        remove().andExpect { status { isConflict() } }

        mockMvc.post("/api/jobs/$jobId/pause") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        remove().andExpect { status { isNoContent() } }

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isNotFound() } }

        // What the fleet actually did outlives the row that described it.
        val trail = auditEntries.findAll().map { it.action }
        assertTrue(trail.contains(AuditAction.BUILD_JOB_START))
        assertTrue(trail.contains(AuditAction.BUILD_JOB_PAUSE))
        assertTrue(trail.contains(AuditAction.BUILD_JOB_DELETE))
    }

    @Test
    fun `an orchestrator runs the fleet but does not clear its records`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )
        mockMvc.post("/api/jobs/$jobId/pause") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        mockMvc.delete("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isForbidden() } }
    }

    /**
     * The gap this closes: leaving the game released the segment, and nothing ever handed one
     * back, so a blip left an agent standing beside the build it had been on until somebody
     * noticed and reassigned it by hand.
     */
    @Test
    fun `an agent that drops out and comes back picks its work up again`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )

        reports(agent, AgentState.LINKED)
        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.segments[0].state") { value("PENDING") }
            jsonPath("$.segments[0].agentId") { value(null) }
        }

        reports(agent, AgentState.ONLINE)
        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
        }
    }

    /** Somebody stopped that job deliberately. Quietly re-crewing it would undo the decision. */
    @Test
    fun `a reconnecting agent does not re-crew a paused job`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString,
            "$.id",
        )
        reports(agent, AgentState.LINKED)
        pause(jobId).andExpect { status { isOk() } }

        reports(agent, AgentState.ONLINE)

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { jsonPath("$.segments[0].state") { value("PENDING") } }
    }

    @Test
    fun `a viewer may read a job but not start one`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        start(build.id!!, listOf(agent.id!!), user = RoleNames.VIEWER)
            .andExpect { status { isForbidden() } }

        start(build.id!!, listOf(agent.id!!)).andExpect { status { isCreated() } }

        mockMvc.get("/api/jobs?buildId=${build.id}") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$.length()") { value(1) }
        }
    }
}

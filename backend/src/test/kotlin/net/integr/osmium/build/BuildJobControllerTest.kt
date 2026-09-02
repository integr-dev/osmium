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

    /**
     * Four cells stacked one on top of another. The flat fixture cannot be cut on height, which is
     * the only axis where the order between pieces means anything.
     */
    private fun stackedSchematic(name: String = "chimney"): Schematic {
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
                sizeX = 1,
                sizeY = 4,
                sizeZ = 1,
                blockCount = 40,
            ),
        )
        index.replaceCells(
            schematic.id!!,
            (0..3).map { y -> Cell(0, y, 0, 10, "stone") },
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

    private fun onlineAgent(label: String, host: Host, server: String = "mc.example.com"): Agent =
        createAgent(label = label, host = host, state = AgentState.ONLINE, server = server)

    private fun start(
        buildId: Long,
        agentIds: List<Long>,
        mode: String = "COLUMNS",
        user: String = RoleNames.ORCHESTRATOR,
        parts: Int? = null,
    ): ResultActionsDsl = mockMvc.post("/api/builds/$buildId/jobs") {
        header(HttpHeaders.AUTHORIZATION, asRole(user))
        contentType = MediaType.APPLICATION_JSON
        content = """{"mode":"$mode","agentIds":[${agentIds.joinToString(",")}]""" +
            (parts?.let { ""","parts":$it""" } ?: "") + "}"
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
    /** A build_progress event as a host sends one. */
    private fun progresses(
        agent: Agent,
        segmentId: Long,
        placed: Long? = null,
        state: String? = null,
        reason: String? = null,
    ) {
        val payload = buildString {
            append("""{"segmentId":$segmentId""")
            placed?.let { append(""","blocksPlaced":$it""") }
            state?.let { append(""","state":"$it"""") }
            reason?.let { append(""","reason":"$it"""") }
            append("}")
        }

        hostReports.onMessage(
            checkNotNull(agent.host.id),
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.BUILD_PROGRESS,
                agentId = agent.id,
                payload = objectMapper.readTree(payload),
            ),
        )
    }

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
            jsonPath("$.serverAddress") { value("mc.example.com") }
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
        val here = onlineAgent("Mason_01", host, server = "mc.example.com")
        val elsewhere = onlineAgent("Mason_02", host, server = "other.example.com")

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
        val here = onlineAgent("Mason_01", host, server = "mc.example.com")
        val alsoHere = onlineAgent("Mason_02", host, server = "mc.example.com")
        val elsewhere = onlineAgent("Mason_03", host, server = "other.example.com")

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

    /**
     * Pausing calls every host off the work while the assignment stays on the row, so resuming has
     * to send it out again. It did not, and the rows came back saying `BUILDING` with nothing
     * behind them: the bots had been told to stop and never told to start.
     *
     * The state going back to `ASSIGNED` is what says so. It has been asked again and has not
     * answered yet, which is exactly what assigned means.
     */
    @Test
    fun `resuming sends the held pieces out again`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        // The host says it started, so the row is BUILDING when the job is stopped.
        progresses(agent, segmentId.toLong(), placed = 10, state = "building")
        pause(jobId).andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("BUILDING") }
        }

        mockMvc.post("/api/jobs/$jobId/resume") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
            // Kept: the blocks are still standing in the world, whatever the job was doing.
            jsonPath("$.segments[0].blocksPlaced") { value(10) }
        }
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

    /**
     * A host counts its own work from zero, so what it reports is added to what was already there.
     *
     * The bug: every hand-over and every resume dropped the piece back to nothing the moment the
     * new holder said "0 placed, building" — which is the first thing any host says, because it has
     * no way of knowing somebody built half of it first.
     */
    @Test
    fun `a piece keeps what is standing when it changes hands`() {
        val host = reachableHost()
        val build = placedBuild()
        val first = onlineAgent("Mason_01", host)
        val second = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(first.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        progresses(first, segmentId.toLong(), placed = 2, state = "building")

        // Taken off the first bot and given to the second, which starts counting at nothing.
        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        mockMvc.post("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"agentId":${second.id}}"""
        }.andExpect {
            status { isOk() }
            // Still two: the blocks are standing in the world whoever is holding the piece.
            jsonPath("$.segments[0].blocksPlaced") { value(2) }
        }

        // The new holder walks the piece from the beginning, so its own count starts below what
        // is standing. The earlier figure holds until it is overtaken.
        progresses(second, segmentId.toLong(), placed = 0, state = "building")
        progresses(second, segmentId.toLong(), placed = 1)

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            // Still two: this bot has not yet replaced as much as was already there, and adding
            // its count to the old one would be counting the same blocks twice.
            jsonPath("$.segments[0].blocksPlaced") { value(2) }
        }

        progresses(second, segmentId.toLong(), placed = 5)

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            // Past it, so its own count is the better answer and takes over.
            jsonPath("$.segments[0].blocksPlaced") { value(5) }
        }
    }

    /**
     * Assigning is allowed while a job is stopped, and must not start anybody building.
     *
     * Crewing a paused job up before resuming it is the ordinary way to fix one that lost an agent.
     * Sending the work as part of that put a bot to building on a job an operator had stopped —
     * and, because the piece was already most of the way there, it read as a bot building nothing.
     */
    @Test
    fun `assigning on a paused job does not set anybody building`() {
        val host = reachableHost()
        val build = placedBuild()
        val first = onlineAgent("Mason_01", host)
        val second = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(first.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        pause(jobId).andExpect { status { isOk() } }
        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        mockMvc.post("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"agentId":${second.id}}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.state") { value("PAUSED") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_02") }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
        }

        // Nothing was sent, so nothing can report: the piece is still assigned and untouched.
        mockMvc.post("/api/jobs/$jobId/resume") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.state") { value("ACTIVE") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_02") }
        }
    }

    /**
     * Taking a live piece off an agent means *not this bot*, so it is not handed back to them.
     *
     * It used to be: the scheduler filled the gap the moment it appeared, and with one agent idle
     * and one piece free that was the same pairing again. The button redrew the row exactly as it
     * had been, which is a control that does nothing.
     */
    @Test
    fun `releasing a live piece keeps it away from the agent it was taken from`() {
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
            // Named, so a free piece nobody picks up is an answer rather than a mystery.
            jsonPath("$.segments[0].releasedFrom") { value("Mason_01") }
            // Still on the job. Handing a piece back is not resigning from the build.
            jsonPath("$.pool.length()") { value(1) }
        }
    }

    /** Anybody else may have it, which is the point of taking it off the first one. */
    @Test
    fun `a released piece goes to another agent as soon as one is free`() {
        val host = reachableHost()
        val build = placedBuild()
        val first = onlineAgent("Mason_01", host)
        val second = onlineAgent("Mason_02", host)

        // Two pieces so both agents are busy, then one is taken off its own.
        val body = start(build.id!!, listOf(first.id!!, second.id!!), parts = 2)
            .andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val held: String = JsonPath.read(body, "$.segments[0].agentLabel")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")
        val other: Int = JsonPath.read(body, "$.segments[1].id")

        // The agent holding the second piece hands it back, leaving itself idle.
        mockMvc.delete("/api/jobs/$jobId/segments/$other/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        // Now the first piece is released: the idle agent is not the one it came from, so it takes it.
        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].agentLabel") { value(if (held == "Mason_01") "Mason_02" else "Mason_01") }
            // Handed out again, so the decision that kept one agent off it is spent.
            jsonPath("$.segments[0].releasedFrom") { value(null) }
        }
    }

    /**
     * The scheduler only runs on an active job, which is what makes a released piece observable at
     * rest: paused, it stays where it was put until somebody resumes.
     */
    @Test
    fun `a piece released on a paused job waits there, reason and all`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        progresses(agent, segmentId.toLong(), state = "failed", reason = "no blocks in inventory")
        mockMvc.post("/api/jobs/$jobId/pause") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("PENDING") }
            jsonPath("$.segments[0].agentId") { value(null) }
            // Kept while it waits: whoever released it did so because of that reason and is off
            // fixing it. It goes when somebody takes the piece, not when they hand it back.
            jsonPath("$.segments[0].failureReason") { value("no blocks in inventory") }
        }

        // Resuming is a scheduling pass, so the piece goes out again without anybody assigning it.
        mockMvc.post("/api/jobs/$jobId/resume") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].failureReason") { value(null) }
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

    /**
     * Blocks placed are **written down, not added up** — the same rule the vitals follow. A host
     * that restarts mid-segment resumes from what it can see, and accumulating deltas would count
     * those blocks a second time.
     */
    @Test
    fun `progress is the number reported, not a running total`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        progresses(agent, segmentId.toLong(), placed = 12, state = "building")
        progresses(agent, segmentId.toLong(), placed = 20, state = "building")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.segments[0].state") { value("BUILDING") }
            jsonPath("$.segments[0].blocksPlaced") { value(20) }
            jsonPath("$.segments[0].lastReportAt") { exists() }
            jsonPath("$.blocksPlaced") { value(20) }
        }
    }

    /** A host that recounts generously must not be able to drive a job past finished. */
    @Test
    fun `a count is clamped to what the split said is there`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")
        val blocks: Int = JsonPath.read(body, "$.segments[0].blocks")

        progresses(agent, segmentId.toLong(), placed = blocks * 10L, state = "building")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { jsonPath("$.segments[0].blocksPlaced") { value(blocks) } }
    }

    /**
     * The one thing that closes a job, and the only place it can happen: nothing but a host can
     * know a segment is finished.
     */
    @Test
    fun `a job finishes when its last segment does`() {
        val host = reachableHost()
        val build = placedBuild()
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(one.id!!, two.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val first: Int = JsonPath.read(body, "$.segments[0].id")
        val second: Int = JsonPath.read(body, "$.segments[1].id")

        progresses(one, first.toLong(), state = "done")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.state") { value("ACTIVE") }
            jsonPath("$.segments[0].state") { value("DONE") }
            // The verdict carries the count with it: a finished segment reading two blocks short
            // for ever is a job that never completes.
            jsonPath("$.segments[0].blocksPlaced") { value(JsonPath.read<Int>(body, "$.segments[0].blocks")) }
        }

        progresses(two, second.toLong(), state = "done")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.state") { value("DONE") }
            jsonPath("$.finishedAt") { exists() }
        }
    }

    @Test
    fun `a segment a host could not build says why`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        progresses(agent, segmentId.toLong(), state = "failed", reason = "no blocks in inventory")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.segments[0].state") { value("FAILED") }
            jsonPath("$.segments[0].failureReason") { value("no blocks in inventory") }
            // Still ACTIVE: deciding a job is over means picking how many failures are too many,
            // and there is no honest number.
            jsonPath("$.state") { value("ACTIVE") }
        }
    }

    /**
     * The gap this closes: `FAILED` was a state nothing could leave. The scheduler only picks up
     * `PENDING`, releasing refused anything not assigned, and a job needs every piece `DONE` - so one
     * failure stranded the whole build, with deleting and rebuilding as the only way out.
     */
    @Test
    fun `a failed piece is retried by releasing it, and the job can then finish`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        progresses(agent, segmentId.toLong(), state = "failed", reason = "no blocks in inventory")

        // Releasing is the retry: the piece goes back and straight out again, carrying no memory of
        // the attempt that failed, because this is a new one.
        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].failureReason") { value(null) }
        }

        // And the job can reach the end, which is what a stranded piece made impossible.
        progresses(agent, segmentId.toLong(), state = "done")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.state") { value("DONE") }
            // A finished job holds nobody. The pool is live membership; who built which piece is on
            // the piece.
            jsonPath("$.pool.length()") { value(0) }
            jsonPath("$.segments[0].agentLabel") { value("Mason_01") }
        }
    }

    /**
     * The pool is what a vertical split needs and a division could not express: more pieces than
     * agents, agents taking the next one when they finish, and a bot added halfway through being
     * useful without anybody deciding which piece it should have.
     */
    @Test
    fun `more pieces than agents, and the next one goes out when one comes in`() {
        val host = reachableHost()
        val build = placedBuild()
        val agent = onlineAgent("Mason_01", host)

        val body = start(build.id!!, listOf(agent.id!!), parts = 2).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val first: Int = JsonPath.read(body, "$.segments[0].id")

        // One agent, two pieces: it holds the first and the second waits its turn.
        assertEquals("ASSIGNED", JsonPath.read<String>(body, "$.segments[0].state"))
        assertEquals("PENDING", JsonPath.read<String>(body, "$.segments[1].state"))

        progresses(agent, first.toLong(), state = "done")

        // Nobody assigned the second one. Finishing the first is what handed it over.
        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.segments[1].state") { value("ASSIGNED") }
            jsonPath("$.segments[1].agentLabel") { value("Mason_01") }
            jsonPath("$.state") { value("ACTIVE") }
        }
    }

    @Test
    fun `an agent added to a running job picks up what is waiting`() {
        val host = reachableHost()
        val build = placedBuild()
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        val jobId: Int = JsonPath.read(
            start(build.id!!, listOf(one.id!!), parts = 2).andReturn().response.contentAsString,
            "$.id",
        )

        // No segment in the request: which piece it gets is the scheduler's business.
        mockMvc.post("/api/jobs/$jobId/agents") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"agentId":${two.id}}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.pool.length()") { value(2) }
            jsonPath("$.segments[1].state") { value("ASSIGNED") }
            jsonPath("$.segments[1].agentLabel") { value("Mason_02") }
        }
    }

    @Test
    fun `taking an agent off a job hands its piece to the rest of the pool`() {
        val host = reachableHost()
        val build = placedBuild()
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(one.id!!, two.id!!), parts = 1)
            .andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")

        // One piece between two agents, so one of them is on the job holding nothing - which is the
        // state the old model had no way to write down.
        assertEquals("Mason_01", JsonPath.read<String>(body, "$.segments[0].agentLabel"))

        mockMvc.delete("/api/jobs/$jobId/agents/${one.id}") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.pool.length()") { value(1) }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
            jsonPath("$.segments[0].agentLabel") { value("Mason_02") }
        }
    }

    @Test
    fun `an agent on one job cannot be pooled into another`() {
        val host = reachableHost()
        val agent = onlineAgent("Mason_01", host)
        val first = placedBuild(name = "north tower")
        val second = placedBuild(name = "south tower")

        val jobId: Int = JsonPath.read(
            start(first.id!!, listOf(agent.id!!), parts = 2).andReturn().response.contentAsString,
            "$.id",
        )

        start(second.id!!, listOf(agent.id!!)).andExpect { status { isConflict() } }

        // Including while it is holding nothing, which is the case the old check got wrong: reading
        // the segments called such an agent free and let a second job take it.
        val segmentId: Int = JsonPath.read(
            mockMvc.get("/api/jobs/$jobId") {
                header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            }.andReturn().response.contentAsString,
            "$.segments[0].id",
        )
        // Paused, so releasing leaves it waiting rather than handing it back immediately.
        mockMvc.post("/api/jobs/$jobId/pause") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }
        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        start(second.id!!, listOf(agent.id!!)).andExpect { status { isConflict() } }
    }
    /**
     * A host reporting on a segment it does not hold is either confused or lying, and neither is a
     * reason to write down a number.
     */
    @Test
    fun `progress is only taken from the agent holding the segment`() {
        val host = reachableHost()
        val build = placedBuild()
        val holder = onlineAgent("Mason_01", host)
        val other = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(holder.id!!)).andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val segmentId: Int = JsonPath.read(body, "$.segments[0].id")

        progresses(other, segmentId.toLong(), placed = 99, state = "building")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.segments[0].blocksPlaced") { value(0) }
            jsonPath("$.segments[0].state") { value("ASSIGNED") }
        }
    }

    /**
     * The rule the whole pool model exists to make possible.
     *
     * A bot is two blocks tall and builds from the floor up, so two agents split by height over the
     * same ground each need to stand exactly where the other still has blocks to place. Cutting on Y
     * is therefore an order rather than a division, and the piece above waits - with an idle agent
     * standing right there, which is an ordinary state rather than a stuck one.
     */
    @Test
    fun `a piece with unbuilt work beneath it is not handed out`() {
        val host = reachableHost()
        val build = placedBuild(schematic = stackedSchematic())
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(one.id!!, two.id!!), mode = "GRID")
            .andReturn().response.contentAsString
        val jobId: Int = JsonPath.read(body, "$.id")
        val bottom: Int = JsonPath.read(body, "$.segments[0].id")

        // Two agents, two pieces, and only one of them out: the upper piece has no floor yet.
        assertEquals("ASSIGNED", JsonPath.read<String>(body, "$.segments[0].state"))
        assertEquals("PENDING", JsonPath.read<String>(body, "$.segments[1].state"))
        assertEquals(listOf(1), JsonPath.read<List<Int>>(body, "$.segments[1].blockedBy"))
        // Both are on the job all the same. One is waiting, which the old model could not say.
        assertEquals(2, JsonPath.read<Int>(body, "$.pool.length()"))

        // Finishing the floor is what releases what stands on it. Nobody assigned anything.
        progresses(one, bottom.toLong(), state = "done")

        mockMvc.get("/api/jobs/$jobId") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect {
            jsonPath("$.segments[1].state") { value("ASSIGNED") }
            jsonPath("$.segments[1].blockedBy.length()") { value(0) }
        }
    }

    /** Full-height prisms have nothing beneath anything, so the rule costs them nothing. */
    @Test
    fun `columns all go out at once`() {
        val host = reachableHost()
        val build = placedBuild()
        val one = onlineAgent("Mason_01", host)
        val two = onlineAgent("Mason_02", host)

        val body = start(build.id!!, listOf(one.id!!, two.id!!)).andReturn().response.contentAsString

        assertEquals("ASSIGNED", JsonPath.read<String>(body, "$.segments[0].state"))
        assertEquals("ASSIGNED", JsonPath.read<String>(body, "$.segments[1].state"))
        assertEquals(0, JsonPath.read<List<Int>>(body, "$.segments[1].blockedBy").size)
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

    /**
     * An agent in the middle of a segment is not to be interrupted.
     *
     * What a builder is carrying *is* the build: it is placing out of a square, and moving a stack
     * out of that square leaves it putting the wrong block somewhere - or nothing - and the damage
     * shows up minutes later as a wall with holes in it, nowhere near the click that caused it.
     *
     * Refused in `AgentService.dispatch`, which every command passes through, so this is the whole
     * class of them rather than these three verbs. See CommandSafetyTest for the classification.
     */
    @Test
    fun `an agent holding a segment refuses what would disturb its inventory`() {
        val host = reachableHost()
        val build = placedBuild()
        val mason = onlineAgent("Mason_01", host)
        // Once, outside the loop: `authAs` creates the account, so asking three times asks for three
        // accounts with one name.
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)

        start(build.id!!, listOf(mason.id!!)).andExpect { status { isCreated() } }

        for (body in listOf(
            "inventory/move" to """{"from":36,"to":9}""",
            "inventory/drop" to """{"slot":36}""",
            "inventory/hold" to """{"slot":40}""",
        )) {
            mockMvc.post("/api/agents/${mason.id}/${body.first}") {
                header(HttpHeaders.AUTHORIZATION, auth)
                contentType = MediaType.APPLICATION_JSON
                content = body.second
            }.andExpect {
                status { isConflict() }
            }
        }
    }

    @Test
    fun `an agent holding a segment can still be talked to and watched`() {
        // The line is *corrupts*, not *interrupts*. An operator watching a build is exactly who
        // needs chat working while it runs, and neither of these touches what the agent is holding.
        val host = reachableHost()
        val build = placedBuild()
        val mason = onlineAgent("Mason_01", host)

        start(build.id!!, listOf(mason.id!!)).andExpect { status { isCreated() } }

        // 503 rather than 409: the command is allowed and gets as far as delivery, where there is
        // no host socket behind the row. Being refused for *building* would be a 409.
        mockMvc.post("/api/agents/${mason.id}/chat") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.ADMINISTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"on my way"}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

}

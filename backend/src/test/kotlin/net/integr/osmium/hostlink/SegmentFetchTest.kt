package net.integr.osmium.hostlink

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.build.model.Build
import net.integr.osmium.build.model.BuildSubstitution
import net.integr.osmium.build.repository.BuildJobRepository
import net.integr.osmium.build.repository.BuildRepository
import net.integr.osmium.schematic.SchematicFixtures
import net.integr.osmium.schematic.SegmentBlocks
import net.integr.osmium.schematic.Vec3i
import net.integr.osmium.schematic.model.Schematic
import net.integr.osmium.schematic.model.SchematicStatus
import net.integr.osmium.schematic.service.SchematicStorage
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import com.jayway.jsonpath.JsonPath
import java.nio.ByteBuffer
import kotlin.test.assertEquals

/**
 * Fetching the blocks of a segment a host has been given.
 *
 * The endpoint is the only thing in Osmium a host pulls rather than being sent, and the only one
 * authenticated by something that is not a JWT or an enrolment token. What is worth testing is
 * therefore two different things: that the bytes describe the right blocks in the right places, and
 * that the ticket is a capability for *one* segment rather than a key to the table.
 */
class SegmentFetchTest : AbstractRestTest() {

    @Autowired private lateinit var schematics: net.integr.osmium.schematic.repository.SchematicRepository
    @Autowired private lateinit var builds: BuildRepository
    @Autowired private lateinit var jobs: BuildJobRepository
    @Autowired private lateinit var storage: SchematicStorage
    @Autowired private lateinit var index: net.integr.osmium.schematic.repository.SchematicIndexRepository

    private val tokens = mutableMapOf<String, String>()

    private fun asRole(role: String): String = tokens.getOrPut(role) { authAs("fetch-$role", role) }

    /**
     * Four blocks in a row along x, at the file's own origin.
     *
     * Written through the real writer and read back by the real decoder: the point of the test is
     * the arithmetic between a file's coordinates and a world's, and a hand-built palette would
     * skip the half of it that comes out of the format.
     */
    private fun readySchematic(): Schematic {
        val bytes = SchematicFixtures.litematic(
            listOf(
                SchematicFixtures.region(
                    position = Vec3i(0, 0, 0),
                    size = Vec3i(4, 1, 1),
                    palette = listOf("minecraft:air", "minecraft:stone", "minecraft:diamond_block"),
                    states = intArrayOf(1, 2, 1, 0),
                ),
            ),
        )

        val schematic = schematics.saveAndFlush(
            Schematic(
                name = "row",
                originalFilename = "row.litematic",
                sizeBytes = bytes.size.toLong(),
                receivedBytes = bytes.size.toLong(),
                status = SchematicStatus.READY,
                uploadedBy = "root",
                originX = 0, originY = 0, originZ = 0,
                cellSize = 1,
                sizeX = 4, sizeY = 1, sizeZ = 1,
                blockCount = 3,
            ),
        )
        storage.append(checkNotNull(schematic.id)) { out -> out.write(bytes) }

        // What a pass would have left behind. The split reads this and never the file, so a fixture
        // that only writes bytes divides into nothing and the job is refused before it starts.
        index.replaceCells(
            checkNotNull(schematic.id),
            listOf(0, 1, 2).map { x -> net.integr.osmium.schematic.Cell(x, 0, 0, 1, "minecraft:stone") },
        )
        return schematic
    }

    /**
     * Starts a job over that schematic, anchored away from the origin so a coordinate that was
     * merely copied through rather than offset shows up as a wrong number.
     */
    private fun startedJob(substitutions: List<Pair<String, String?>> = emptyList()): Pair<Int, String> {
        val schematic = readySchematic()
        val build = Build(
            schematic = schematic,
            name = "row plan",
            placeX = 100, placeY = 64, placeZ = -30,
            createdBy = "root",
        )
        substitutions.forEach { (from, to) ->
            build.substitutions += BuildSubstitution(build = build, from = from, to = to)
        }
        builds.saveAndFlush(build)

        val agent = createAgent("Mason_01", reachableHost(), state = AgentState.ONLINE)

        val body = mockMvc.post("/api/builds/${build.id}/jobs") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"mode":"COLUMNS","agentIds":[${agent.id}]}"""
        }.andReturn().response.contentAsString

        val jobId: Int = JsonPath.read(body, "$.id")
        val ticket = checkNotNull(
            jobs.findById(jobId.toLong()).orElseThrow().segments.single().fetchTicket,
        ) { "An assigned segment must carry a ticket" }

        return jobId to ticket
    }

    private fun fetch(jobId: Int, segmentId: Long, ticket: String?) =
        mockMvc.get("/api/hostlink/jobs/$jobId/segments/$segmentId") {
            if (ticket != null) header("X-Osmium-Ticket", ticket)
        }

    private fun segmentIdOf(jobId: Int): Long =
        checkNotNull(jobs.findById(jobId.toLong()).orElseThrow().segments.single().id)

    @Test
    fun `the blocks arrive in world coordinates, in build order`() {
        val (jobId, ticket) = startedJob()

        val bytes = fetch(jobId, segmentIdOf(jobId), ticket).andReturn().response.contentAsByteArray
        val body = ByteBuffer.wrap(bytes)

        assertEquals("OSM1", String(ByteArray(4).also { body.get(it) }, Charsets.UTF_8))

        val palette = (0 until body.short.toInt()).map {
            String(ByteArray(body.short.toInt()).also { name -> body.get(name) }, Charsets.UTF_8)
        }
        // Air never reaches the sink, so it is not in the palette a host is handed either.
        assertEquals(listOf("minecraft:stone", "minecraft:diamond_block"), palette)

        // The anchor moved the file's minimum corner to 100, 64, -30, and the box is the split's.
        assertEquals(100, body.int)
        assertEquals(64, body.int)
        assertEquals(-30, body.int)
        repeat(3) { body.int }

        assertEquals(3, body.int)
        // Ascending, and the fourth position was air, so nothing is sent for it.
        assertEquals(0, body.int); assertEquals(0, body.short.toInt())
        assertEquals(1, body.int); assertEquals(1, body.short.toInt())
        assertEquals(2, body.int); assertEquals(0, body.short.toInt())
        assertEquals(0, body.remaining())
    }

    /**
     * A substitution to nothing removes the block rather than sending a hole for the host to read as
     * one. "I do not have forty stacks of diamond" is the ordinary reason to reach for it.
     */
    @Test
    fun `a block substituted away is simply absent`() {
        val (jobId, ticket) = startedJob(listOf("diamond_block" to null))

        val bytes = fetch(jobId, segmentIdOf(jobId), ticket).andReturn().response.contentAsByteArray
        val body = ByteBuffer.wrap(bytes)

        body.get(ByteArray(4))
        val palette = (0 until body.short.toInt()).map {
            String(ByteArray(body.short.toInt()).also { name -> body.get(name) }, Charsets.UTF_8)
        }
        assertEquals(listOf("minecraft:stone"), palette)

        repeat(6) { body.int }
        assertEquals(2, body.int)
    }

    /**
     * The rules are matched with the namespace stripped, because a file's palette carries it and the
     * block picker does not. Comparing as written is how a rule silently applied to nothing, twice.
     */
    @Test
    fun `a substitution matches across the minecraft namespace`() {
        val (jobId, ticket) = startedJob(listOf("diamond_block" to "cobblestone"))

        val bytes = fetch(jobId, segmentIdOf(jobId), ticket).andReturn().response.contentAsByteArray
        val body = ByteBuffer.wrap(bytes)

        body.get(ByteArray(4))
        val palette = (0 until body.short.toInt()).map {
            String(ByteArray(body.short.toInt()).also { name -> body.get(name) }, Charsets.UTF_8)
        }
        assertEquals(listOf("minecraft:stone", "cobblestone"), palette)
    }

    @Test
    fun `a fetch without a ticket is refused`() {
        val (jobId, _) = startedJob()

        fetch(jobId, segmentIdOf(jobId), null).andExpect { status { isUnauthorized() } }
        fetch(jobId, segmentIdOf(jobId), "not-a-ticket").andExpect { status { isUnauthorized() } }
    }

    /**
     * The path is checked against what the ticket names rather than used to find it. Getting that
     * backwards is what turns one leaked capability into a key for every segment.
     */
    @Test
    fun `a ticket cannot be pointed at another segment`() {
        val (jobId, ticket) = startedJob()
        val segmentId = segmentIdOf(jobId)

        fetch(jobId, segmentId + 1, ticket).andExpect { status { isUnauthorized() } }
        fetch(jobId + 1, segmentId, ticket).andExpect { status { isUnauthorized() } }
    }

    /**
     * Releasing the segment is what ends the ticket's life — not a timer, and not the job ending.
     * The capability dies with the reason it existed.
     */
    @Test
    fun `releasing the segment retires its ticket`() {
        val (jobId, ticket) = startedJob()
        val segmentId = segmentIdOf(jobId)

        fetch(jobId, segmentId, ticket).andExpect { status { isOk() } }

        mockMvc.delete("/api/jobs/$jobId/segments/$segmentId/assignment") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isOk() } }

        fetch(jobId, segmentId, ticket).andExpect { status { isUnauthorized() } }
    }

    /** A body this size is one agent's work behind a capability, and nothing else may keep a copy. */
    @Test
    fun `the response is not cacheable`() {
        val (jobId, ticket) = startedJob()

        fetch(jobId, segmentIdOf(jobId), ticket).andExpect {
            status { isOk() }
            header { string("Cache-Control", "no-store") }
            header { string("Content-Type", SegmentBlocks.CONTENT_TYPE) }
        }
    }
}

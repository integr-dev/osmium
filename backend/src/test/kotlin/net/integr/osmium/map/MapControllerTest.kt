package net.integr.osmium.map

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostReportService
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.map.model.MapTile
import net.integr.osmium.map.repository.MapTileRepository
import net.integr.osmium.map.service.MapService
import net.integr.osmium.security.RoleNames
import org.hamcrest.Matchers.hasSize
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.get
import tools.jackson.databind.ObjectMapper
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The map, end to end: what a host reports, what is stored, and what a screen reads back.
 *
 * The pixels are the part worth testing. Everything else here is one row in one table, but a tile
 * is 256 indices and 256 heights whose meaning is entirely positional - so the assertions put a
 * known block at a known pixel and read it back out at the far end, because a map that is drawn
 * wrong looks exactly like a map that is drawn.
 */
class MapControllerTest : AbstractRestTest() {

    @Autowired private lateinit var hostReports: HostReportService
    @Autowired private lateinit var tiles: MapTileRepository
    @Autowired private lateinit var mapService: MapService
    @Autowired private lateinit var objectMapper: ObjectMapper

    private val encoder: Base64.Encoder = Base64.getEncoder()

    private val OVERWORLD = "overworld"

    /** A tile whose every column is the first palette entry, at one height. */
    private fun flat(palette: List<String>, height: Int = 70): Pair<ByteArray, ByteArray> {
        val blocks = ByteArray(MapTile.AREA)
        val heights = ByteArray(MapTile.AREA * 2)
        for (cell in 0 until MapTile.AREA) {
            heights[cell * 2] = (height and 0xff).toByte()
            heights[cell * 2 + 1] = ((height shr 8) and 0xff).toByte()
        }
        check(palette.isNotEmpty())
        return blocks to heights
    }

    private fun report(
        agent: Agent,
        hostId: Long,
        x: Int,
        z: Int,
        palette: List<String>,
        height: Int = 70,
        dimension: String = OVERWORLD,
    ) {
        val (blocks, heights) = flat(palette, height)
        hostReports.onMessage(
            hostId,
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.MAP_TILE,
                agentId = agent.id,
                payload = objectMapper.readTree(
                    """
                    {"x":$x,"z":$z,"dimension":"$dimension",
                     "palette":${palette.joinToString(",", "[", "]") { "\"$it\"" }},
                     "blocks":"${encoder.encodeToString(blocks)}",
                     "heights":"${encoder.encodeToString(heights)}"}
                    """.trimIndent(),
                ),
            ),
        )
    }

    // ---- ingest ----------------------------------------------------------------------------------

    @Test
    fun `a host reporting a tile has it stored against the agent's server`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host, server = "mc.example.com")

        report(agent, checkNotNull(host.id), x = 3, z = -4, palette = listOf("grass_block"))

        val stored = tiles.inArea("mc.example.com", OVERWORLD, minX = 3, minZ = -4, maxX = 3, maxZ = -4)
        assertEquals(1, stored.size)
        assertEquals(listOf("grass_block"), stored.first().palette)
        assertEquals(agent.id, stored.first().agentId)
        assertEquals("Mason_01", stored.first().agentLabel)
    }

    /**
     * A map is about a place, so the newest look at a chunk stands - even when it comes from a
     * different agent. The world is shared and changes under everyone.
     */
    @Test
    fun `a second agent looking at the same chunk replaces the first reading`() {
        val host = reachableHost()
        val first = createAgent("Mason_01", host)
        val second = createAgent("Mason_02", host)

        report(first, checkNotNull(host.id), x = 0, z = 0, palette = listOf("grass_block"))
        report(second, checkNotNull(host.id), x = 0, z = 0, palette = listOf("stone"))

        val stored = tiles.inArea("mc.example.com", OVERWORLD, minX = 0, minZ = 0, maxX = 0, maxZ = 0)
        assertEquals(1, stored.size, "the chunk was stored twice rather than replaced")
        assertEquals(listOf("stone"), stored.first().palette)
        assertEquals("Mason_02", stored.first().agentLabel)
    }

    /** Agents on different servers are charting different worlds, whatever the coordinates say. */
    @Test
    fun `two servers keep separate maps at the same coordinates`() {
        val host = reachableHost()
        val here = createAgent("Mason_01", host, server = "mc.example.com")
        val there = createAgent("Mason_02", host, server = "other.example.com")

        report(here, checkNotNull(host.id), x = 0, z = 0, palette = listOf("grass_block"))
        report(there, checkNotNull(host.id), x = 0, z = 0, palette = listOf("netherrack"))

        assertEquals(listOf("grass_block"), tiles.inArea("mc.example.com", OVERWORLD, 0, 0, 0, 0).single().palette)
        assertEquals(listOf("netherrack"), tiles.inArea("other.example.com", OVERWORLD, 0, 0, 0, 0).single().palette)
    }

    /**
     * A tile of the wrong length is a row every later reader would have to defend against, and the
     * browser drawing it would run off the end of the array. Refused at the door.
     */
    @Test
    fun `a tile of the wrong size is refused rather than stored`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(
            checkNotNull(host.id),
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.MAP_TILE,
                agentId = agent.id,
                payload = objectMapper.readTree(
                    """{"x":0,"z":0,"palette":["stone"],
                        "blocks":"${encoder.encodeToString(ByteArray(8))}",
                        "heights":"${encoder.encodeToString(ByteArray(16))}"}""",
                ),
            ),
        )

        assertTrue(tiles.inArea("mc.example.com", OVERWORLD, 0, 0, 0, 0).isEmpty())
    }

    /** An index nothing in the palette answers for would draw whatever colour happened to be next. */
    @Test
    fun `a tile indexing past its palette is refused`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        val blocks = ByteArray(MapTile.AREA)
        blocks[5] = 3 // A palette of one has only index 0.
        val heights = ByteArray(MapTile.AREA * 2)

        hostReports.onMessage(
            checkNotNull(host.id),
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.MAP_TILE,
                agentId = agent.id,
                payload = objectMapper.readTree(
                    """{"x":0,"z":0,"palette":["stone"],
                        "blocks":"${encoder.encodeToString(blocks)}",
                        "heights":"${encoder.encodeToString(heights)}"}""",
                ),
            ),
        )

        assertTrue(tiles.inArea("mc.example.com", OVERWORLD, 0, 0, 0, 0).isEmpty())
    }

    /** An agent between servers has nowhere to file a reading, and guessing would put one world's
     * ground onto another's map. */
    @Test
    fun `a tile from an agent with no server is dropped`() {
        val host = reachableHost()
        val agent = agentRepository.saveAndFlush(
            net.integr.osmium.agent.model.Agent(label = "Drifter", host = host, serverAddress = null),
        )

        report(agent, checkNotNull(host.id), x = 0, z = 0, palette = listOf("stone"))

        assertTrue(tiles.extents().isEmpty())
    }

    // ---- reading ---------------------------------------------------------------------------------

    @Test
    fun `the area endpoint returns the tiles inside the box and nothing outside it`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)
        val hostId = checkNotNull(host.id)

        report(agent, hostId, x = 0, z = 0, palette = listOf("grass_block"))
        report(agent, hostId, x = 2, z = 2, palette = listOf("stone"))
        report(agent, hostId, x = 9, z = 9, palette = listOf("sand"))

        mockMvc.get("/api/map/tiles?server=mc.example.com&dimension=overworld&minX=0&minZ=0&maxX=2&maxZ=2") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$.serverAddress") { value("mc.example.com") }
            jsonPath("$.dimension") { value("overworld") }
            jsonPath("$.tiles") { value(hasSize<Any>(2)) }
            // Ordered north to south, then west to east.
            jsonPath("$.tiles[0].x") { value(0) }
            jsonPath("$.tiles[1].x") { value(2) }
        }
    }

    /** Corners included: an area of one chunk has to be askable, and is the commonest single read. */
    @Test
    fun `both corners of the box are inside it`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        report(agent, checkNotNull(host.id), x = -1, z = -1, palette = listOf("stone"))

        assertEquals(1, mapService.area("mc.example.com", OVERWORLD, minX = -1, minZ = -1, maxX = -1, maxZ = -1).size)
    }

    /** Each tile is most of a kilobyte, so an unbounded window is a denial of service with a URL. */
    @Test
    fun `an area larger than the cap is refused`() {
        mockMvc.get("/api/map/tiles?server=mc.example.com&dimension=overworld&minX=0&minZ=0&maxX=999&maxZ=999") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", RoleNames.VIEWER))
        }.andExpect { status { isBadRequest() } }
    }

    /**
     * The two extremes of the integer range multiply to something that overflows an Int and comes
     * back negative, which would pass the size check it is meant to fail.
     */
    @Test
    fun `an area spanning the whole coordinate range is refused rather than overflowing`() {
        mockMvc.get(
            "/api/map/tiles?server=mc.example.com&dimension=overworld" +
                "&minX=${Int.MIN_VALUE}&minZ=${Int.MIN_VALUE}&maxX=${Int.MAX_VALUE}&maxZ=${Int.MAX_VALUE}",
        ) {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", RoleNames.VIEWER))
        }.andExpect { status { isBadRequest() } }
    }

    @Test
    fun `the servers endpoint reports what each map covers`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)
        val hostId = checkNotNull(host.id)

        report(agent, hostId, x = -3, z = 4, palette = listOf("stone"))
        report(agent, hostId, x = 7, z = -2, palette = listOf("sand"))

        mockMvc.get("/api/map/servers") {
            header(HttpHeaders.AUTHORIZATION, authAs("watcher", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].serverAddress") { value("mc.example.com") }
            jsonPath("$[0].dimension") { value("overworld") }
            jsonPath("$[0].tiles") { value(2) }
            jsonPath("$[0].minX") { value(-3) }
            jsonPath("$[0].maxX") { value(7) }
            jsonPath("$[0].minZ") { value(-2) }
            jsonPath("$[0].maxZ") { value(4) }
        }
    }

    @Test
    fun `a server nobody has charted is not listed`() {
        assertTrue(tiles.extents().none { it.serverAddress == "nowhere.example.com" })
    }

    /**
     * The dimensions are separate places that happen to share a coordinate system - and the
     * Nether's is compressed eightfold against the Overworld's on top of that. Filed together, an
     * agent stepping through a portal does not add to the map, it overwrites it.
     */
    @Test
    fun `two dimensions keep separate maps at the same coordinates`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)
        val hostId = checkNotNull(host.id)

        report(agent, hostId, x = 0, z = 0, palette = listOf("grass_block"))
        report(agent, hostId, x = 0, z = 0, palette = listOf("netherrack"), dimension = "the_nether")

        assertEquals(
            listOf("grass_block"),
            tiles.inArea("mc.example.com", OVERWORLD, 0, 0, 0, 0).single().palette,
        )
        assertEquals(
            listOf("netherrack"),
            tiles.inArea("mc.example.com", "the_nether", 0, 0, 0, 0).single().palette,
        )
    }

    /** A host too old to say is reporting from an agent that is nonetheless somewhere. */
    @Test
    fun `a tile with no dimension is filed in the overworld`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(
            checkNotNull(host.id),
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.MAP_TILE,
                agentId = agent.id,
                payload = objectMapper.readTree(
                    """{"x":0,"z":0,"palette":["stone"],
                        "blocks":"${encoder.encodeToString(ByteArray(MapTile.AREA))}",
                        "heights":"${encoder.encodeToString(ByteArray(MapTile.AREA * 2))}"}""",
                ),
            ),
        )

        assertEquals(1, tiles.inArea("mc.example.com", OVERWORLD, 0, 0, 0, 0).size)
    }

    @Test
    fun `each world is listed with its own extent`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)
        val hostId = checkNotNull(host.id)

        report(agent, hostId, x = 0, z = 0, palette = listOf("grass_block"))
        report(agent, hostId, x = 5, z = 5, palette = listOf("netherrack"), dimension = "the_nether")

        val listed = tiles.extents().filter { it.serverAddress == "mc.example.com" }
        assertEquals(setOf(OVERWORLD, "the_nether"), listed.map { it.dimension }.toSet())
        assertEquals(1, listed.single { it.dimension == "the_nether" }.tiles)
    }

    // ---- the pixels ------------------------------------------------------------------------------

    /**
     * The bytes are the contract. A tile's meaning is entirely positional, so this puts one block at
     * one pixel and reads it back through the API, which is the only assertion that would catch the
     * palette, the indices and the heights being shuffled relative to each other.
     */
    @Test
    fun `pixels survive the round trip cell for cell`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        val blocks = ByteArray(MapTile.AREA)
        val heights = ByteArray(MapTile.AREA * 2)
        // Water at chunk-local x=3, z=5, sixteen blocks lower than the stone around it.
        val marked = 5 * MapTile.TILE + 3
        for (cell in 0 until MapTile.AREA) {
            val height = if (cell == marked) 54 else 70
            heights[cell * 2] = (height and 0xff).toByte()
            heights[cell * 2 + 1] = ((height shr 8) and 0xff).toByte()
        }
        blocks[marked] = 1

        hostReports.onMessage(
            checkNotNull(host.id),
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.MAP_TILE,
                agentId = agent.id,
                payload = objectMapper.readTree(
                    """{"x":0,"z":0,"palette":["stone","water"],
                        "blocks":"${encoder.encodeToString(blocks)}",
                        "heights":"${encoder.encodeToString(heights)}"}""",
                ),
            ),
        )

        val stored = tiles.inArea("mc.example.com", OVERWORLD, 0, 0, 0, 0).single()
        assertEquals(listOf("stone", "water"), stored.palette)
        assertEquals(1, stored.blocks[marked].toInt())
        assertEquals(0, stored.blocks[marked - 1].toInt())
        assertEquals(54, readHeight(stored.heights, marked))
        assertEquals(70, readHeight(stored.heights, marked - 1))
    }

    /** A column with nothing in it is negative, which a reader treating heights as unsigned loses. */
    @Test
    fun `an empty column survives as the sentinel and not as a height`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        val heights = ByteArray(MapTile.AREA * 2)
        for (cell in 0 until MapTile.AREA) {
            heights[cell * 2] = (MapTile.EMPTY and 0xff).toByte()
            heights[cell * 2 + 1] = ((MapTile.EMPTY shr 8) and 0xff).toByte()
        }

        hostReports.onMessage(
            checkNotNull(host.id),
            HostEnvelope(
                kind = MessageKind.EVENT,
                type = EventType.MAP_TILE,
                agentId = agent.id,
                payload = objectMapper.readTree(
                    """{"x":0,"z":0,"palette":["stone"],
                        "blocks":"${encoder.encodeToString(ByteArray(MapTile.AREA))}",
                        "heights":"${encoder.encodeToString(heights)}"}""",
                ),
            ),
        )

        val stored = tiles.inArea("mc.example.com", OVERWORLD, 0, 0, 0, 0).single()
        assertEquals(MapTile.EMPTY, readHeight(stored.heights, 0))
    }

    private fun readHeight(heights: ByteArray, cell: Int): Int {
        val low = heights[cell * 2].toInt() and 0xff
        val high = heights[cell * 2 + 1].toInt()
        return (high shl 8) or low
    }

    // ---- authorization ---------------------------------------------------------------------------

    @Test
    fun `an anonymous request is rejected`() {
        mockMvc.get("/api/map/tiles?server=mc.example.com&dimension=overworld&minX=0&minZ=0&maxX=1&maxZ=1")
            .andExpect { status { isUnauthorized() } }
        mockMvc.get("/api/map/servers").andExpect { status { isUnauthorized() } }
    }
}

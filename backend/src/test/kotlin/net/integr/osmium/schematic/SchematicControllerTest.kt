package net.integr.osmium.schematic

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.TestcontainersConfiguration
import net.integr.osmium.account.model.User
import net.integr.osmium.account.repository.RoleRepository
import net.integr.osmium.account.repository.UserRepository
import net.integr.osmium.schematic.repository.SchematicIndexRepository
import net.integr.osmium.schematic.repository.SchematicRepository
import net.integr.osmium.schematic.service.SchematicStorage
import net.integr.osmium.security.RoleNames
import net.integr.osmium.security.encodeRequired
import net.integr.osmium.web.ApiExceptionHandler
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.put

/**
 * The upload path end to end, against a real database and a real directory.
 *
 * **Not transactional**, unlike the other REST tests. The analysis runs on a worker thread, so a
 * row inside an uncommitted test transaction would be invisible to it and every upload would sit at
 * PENDING forever. Cleaned up explicitly instead — the same trade the socket tests make.
 */
@SpringBootTest(
    properties = [
        // Stated rather than inherited: this test asserts on the refusal, so it should fail when
        // the accepted range changes rather than quietly follow it.
        "osmium.schematic.min-data-version=1519",
        "osmium.schematic.max-data-version=4903",
        "osmium.schematic.directory=\${java.io.tmpdir}/osmium-schematic-test",
        "osmium.schematic.max-size=1MB",
    ]
)
@AutoConfigureMockMvc
@Import(TestcontainersConfiguration::class)
class SchematicControllerTest {

    @Autowired private lateinit var mockMvc: MockMvc
    @Autowired private lateinit var repository: SchematicRepository
    @Autowired private lateinit var indexRepository: SchematicIndexRepository
    @Autowired private lateinit var storage: SchematicStorage
    @Autowired private lateinit var userRepository: UserRepository
    @Autowired private lateinit var roleRepository: RoleRepository
    @Autowired private lateinit var passwordEncoder: PasswordEncoder

    private val file: ByteArray = SchematicFixtures.litematic(
        listOf(
            SchematicFixtures.region(
                size = Vec3i(4, 2, 2),
                palette = listOf("minecraft:air", "minecraft:stone"),
                states = IntArray(16) { if (it % 2 == 0) 1 else 0 },
            )
        )
    )

    @BeforeEach
    fun signIn() {
        listOf(
            "sch-viewer" to RoleNames.VIEWER,
            "sch-orchestrator" to RoleNames.ORCHESTRATOR,
            "sch-admin" to RoleNames.ADMINISTRATOR,
        ).forEach { (name, role) ->
            if (userRepository.findByUsername(name) == null) {
                userRepository.saveAndFlush(
                    User(
                        username = name,
                        passwordHash = passwordEncoder.encodeRequired("password"),
                        role = roleRepository.findByName(role),
                    )
                )
            }
        }
    }

    @AfterEach
    fun clean() {
        repository.findAll().forEach { storage.delete(it.id!!) }
        repository.deleteAll()
        userRepository.findAll()
            .filter { it.username.startsWith("sch-") }
            .forEach(userRepository::delete)
    }

    private fun token(username: String): String = JsonPath.read(
        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"$username","password":"password"}"""
        }.andReturn().response.contentAsString,
        "$.token",
    )

    private fun create(user: String = "sch-orchestrator", name: String = "cathedral", size: Long = file.size.toLong()) =
        mockMvc.post("/api/schematics") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token(user)}")
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"$name","filename":"cathedral.litematic","sizeBytes":$size}"""
        }

    private fun send(id: Long, offset: Long, bytes: ByteArray, user: String = "sch-orchestrator") =
        mockMvc.put("/api/schematics/$id/content?offset=$offset") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token(user)}")
            contentType = MediaType.APPLICATION_OCTET_STREAM
            content = bytes
        }

    /** The analysis is on another thread, so the test waits for it rather than assuming. */
    private fun settled(id: Long): String {
        repeat(100) {
            val status = repository.findById(id).get().status.name
            if (status == "READY" || status == "FAILED") return status
            Thread.sleep(100)
        }
        return repository.findById(id).get().status.name
    }

    @Test
    fun `uploads in chunks and reads the file`() {
        val id: Int = JsonPath.read(create().andReturn().response.contentAsString, "$.id")

        val half = file.size / 2
        send(id.toLong(), 0, file.copyOfRange(0, half)).andExpect {
            status { isOk() }
            jsonPath("$.receivedBytes") { value(half) }
            jsonPath("$.status") { value("UPLOADING") }
        }
        send(id.toLong(), half.toLong(), file.copyOfRange(half, file.size)).andExpect {
            status { isOk() }
            jsonPath("$.status") { value("PENDING") }
        }

        val status = settled(id.toLong())
        val done = repository.findById(id.toLong()).get()

        assertEquals("READY", status, done.failure ?: "no failure was recorded")
        assertEquals(SchematicFormat.LITEMATIC, done.format)
        // Every second position is stone, and air is not a block.
        assertEquals(8L, done.blockCount)
        assertEquals(16L, done.volume)
        assertEquals(1, done.regionCount)
        assertNotNull(done.contentHash)
    }

    @Test
    fun `leaves behind an index nothing has to read the file again for`() {
        // Two block types over one cell, so the counts are checkable by hand: 12 stone and 4 glass
        // in a 4x2x2 box that fits inside a single 16-block cell.
        val mixed = SchematicFixtures.litematic(
            listOf(
                SchematicFixtures.region(
                    position = Vec3i(-100, 60, -100),
                    size = Vec3i(4, 2, 2),
                    palette = listOf("minecraft:air", "minecraft:stone", "minecraft:glass"),
                    states = IntArray(16) { if (it % 4 == 0) 2 else 1 },
                )
            )
        )
        val id: Int = JsonPath.read(
            create(name = "indexed", size = mixed.size.toLong()).andReturn().response.contentAsString,
            "$.id",
        )
        send(id.toLong(), 0, mixed)
        assertEquals("READY", settled(id.toLong()))

        val schematic = repository.findById(id.toLong()).get()
        // The minimum corner, which is what the box is drawn at and what cells are measured from.
        assertEquals(-100, schematic.originX)
        // Small enough to measure a block at a time, which is what gives a split somewhere to cut.
        assertEquals(1, schematic.cellSize)

        val cells = indexRepository.cellsOf(id.toLong())
        assertEquals(16, cells.size)
        assertEquals(16, cells.sumOf { it.blocks })
        assertEquals(
            listOf(Material("minecraft:stone", 12), Material("minecraft:glass", 4)),
            indexRepository.materialsOf(id.toLong()),
        )

        // Heaviest first, because that is the order a material list is read in.
        mockMvc.get("/api/schematics/$id/materials") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-viewer")}")
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].name") { value("minecraft:stone") }
            jsonPath("$[0].blocks") { value(12) }
        }
    }

    @Test
    fun `divides a schematic between agents`() {
        val id: Int = JsonPath.read(create().andReturn().response.contentAsString, "$.id")
        send(id.toLong(), 0, file)
        assertEquals("READY", settled(id.toLong()))

        mockMvc.get("/api/schematics/$id/split?mode=COLUMNS&parts=2") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-viewer")}")
        }.andExpect {
            status { isOk() }
            jsonPath("$.requested") { value(2) }
            jsonPath("$.parts") { value(2) }
            jsonPath("$.blocks") { value(8) }
            // Eight blocks between two agents is four each, and anything else means the cut was
            // placed by geometry rather than by count.
            jsonPath("$.segments[0].blocks") { value(4) }
            jsonPath("$.segments[1].blocks") { value(4) }
            jsonPath("$.segments[0].sharePercent") { value(50) }
        }
    }

    @Test
    fun `refuses to divide a schematic that has not been read`() {
        // There is no index yet, so any answer would be invented. The row exists from the moment
        // the upload starts, which is minutes before there is anything to divide.
        val id: Int = JsonPath.read(create().andReturn().response.contentAsString, "$.id")

        mockMvc.get("/api/schematics/$id/split?mode=GRID&parts=4") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-viewer")}")
        }.andExpect { status { isConflict() } }
    }

    @Test
    fun `takes the index with the schematic`() {
        val id: Int = JsonPath.read(create().andReturn().response.contentAsString, "$.id")
        send(id.toLong(), 0, file)
        settled(id.toLong())
        assertTrue(indexRepository.cellsOf(id.toLong()).isNotEmpty())

        mockMvc.delete("/api/schematics/$id") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-admin")}")
        }.andExpect { status { isNoContent() } }

        // Cascaded by the database rather than by the service. Orphaned cells are invisible — they
        // belong to no schematic, so nothing ever lists them — and they are the bulk of these tables.
        assertTrue(indexRepository.cellsOf(id.toLong()).isEmpty())
        assertTrue(indexRepository.materialsOf(id.toLong()).isEmpty())
    }

    @Test
    fun `answers a chunk sent from the wrong place with where it actually is`() {
        val id: Int = JsonPath.read(create().andReturn().response.contentAsString, "$.id")
        send(id.toLong(), 0, file.copyOfRange(0, 10))

        // What resuming is: a client unsure of what arrived is told, in the same round trip that
        // refused it, rather than having to ask and then send.
        send(id.toLong(), 0, file.copyOfRange(0, 10)).andExpect {
            status { isConflict() }
            header { string(ApiExceptionHandler.EXPECTED_OFFSET, "10") }
        }
    }

    @Test
    fun `refuses a file larger than this deployment accepts`() {
        // Refused on the small request that declares the size, not after the bytes have arrived.
        create(size = 2 * 1024 * 1024).andExpect { status { isConflict() } }
    }

    @Test
    fun `records a file from outside the accepted versions as failed, with the reason`() {
        val old = SchematicFixtures.litematic(
            listOf(
                SchematicFixtures.region(
                    size = Vec3i(1, 1, 1),
                    palette = listOf("minecraft:stone"),
                    states = intArrayOf(0),
                )
            ),
            dataVersion = 1000,
        )
        val id: Int = JsonPath.read(
            create(name = "old", size = old.size.toLong()).andReturn().response.contentAsString,
            "$.id",
        )
        send(id.toLong(), 0, old)

        assertEquals("FAILED", settled(id.toLong()))
        // On the row, not only in a log: the operator is the one who can do something about it.
        assertTrue(repository.findById(id.toLong()).get().failure!!.contains("1000"))
    }

    @Test
    fun `a viewer may look but not upload`() {
        mockMvc.get("/api/schematics") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-viewer")}")
        }.andExpect { status { isOk() } }

        create(user = "sch-viewer").andExpect { status { isForbidden() } }
    }

    @Test
    fun `an orchestrator may upload and rename but not delete`() {
        val id: Int = JsonPath.read(create().andReturn().response.contentAsString, "$.id")

        mockMvc.patch("/api/schematics/$id") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-orchestrator")}")
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"nave"}"""
        }.andExpect { status { isOk() } }

        // A delete takes a file that may have cost hours to transfer, and every plan computed from
        // it. It sits with the tier that holds the fleet's other irreversible operations.
        mockMvc.delete("/api/schematics/$id") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-orchestrator")}")
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `an administrator deletes the row and the file with it`() {
        val id: Int = JsonPath.read(create().andReturn().response.contentAsString, "$.id")
        send(id.toLong(), 0, file)
        settled(id.toLong())

        assertTrue(storage.exists(id.toLong()))

        mockMvc.delete("/api/schematics/$id") {
            header(HttpHeaders.AUTHORIZATION, "Bearer ${token("sch-admin")}")
        }.andExpect { status { isNoContent() } }

        // A row without its file lists, opens and fails at everything. Both go, or neither.
        assertTrue(repository.findById(id.toLong()).isEmpty)
        assertTrue(!storage.exists(id.toLong()))
    }

    @Test
    fun `refuses a second schematic with the same name`() {
        create().andExpect { status { isCreated() } }
        create().andExpect { status { isConflict() } }
    }
}

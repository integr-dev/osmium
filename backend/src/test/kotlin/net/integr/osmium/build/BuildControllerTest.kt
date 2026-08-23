package net.integr.osmium.build

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.build.repository.BuildRepository
import net.integr.osmium.schematic.model.Schematic
import net.integr.osmium.schematic.model.SchematicStatus
import net.integr.osmium.schematic.repository.SchematicRepository
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional

/**
 * Build plans: a schematic, where it stands, and what it is built out of.
 *
 * Placement is an anchor for the minimum corner rather than an offset, and it is all three
 * coordinates or none — the tests that matter here are the ones about the states in between.
 */
class BuildControllerTest : AbstractRestTest() {

    @Autowired private lateinit var builds: BuildRepository
    @Autowired private lateinit var schematics: SchematicRepository

    /**
     * One header per role, made once. `authAs` creates the account as a side effect, so asking it
     * twice in a test is a duplicate username rather than a second look at the same person.
     */
    private val tokens = mutableMapOf<String, String>()

    private fun asRole(role: String): String =
        tokens.getOrPut(role) { authAs("planner-${role}", role) }

    private fun schematic(name: String = "cathedral"): Schematic = schematics.saveAndFlush(
        Schematic(
            name = name,
            originalFilename = "$name.litematic",
            sizeBytes = 1,
            receivedBytes = 1,
            status = SchematicStatus.READY,
            uploadedBy = "root",
        ),
    )

    private fun create(body: String, user: String = RoleNames.ORCHESTRATOR) =
        mockMvc.post("/api/builds") {
            header(HttpHeaders.AUTHORIZATION, asRole(user))
            contentType = MediaType.APPLICATION_JSON
            content = body
        }

    @Test
    fun `a build can be created unplaced and placed afterwards`() {
        val id = schematic().id

        // Unplaced is a real state, not a half-made row: a plan usually exists before anybody has
        // stood in the world and read a coordinate off the screen.
        val created = create("""{"name":"north tower","schematicId":$id}""")
            .andExpect {
                status { isCreated() }
                jsonPath("$.placed") { value(false) }
                jsonPath("$.placement") { doesNotExist() }
            }
            .andReturn().response.contentAsString

        val build: Int = JsonPath.read(created, "$.id")

        mockMvc.patch("/api/builds/$build") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"placement":{"x":100,"y":64,"z":-200}}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.placed") { value(true) }
            jsonPath("$.placement.x") { value(100) }
            jsonPath("$.placement.z") { value(-200) }
        }
    }

    /** Absent and null mean opposite things over JSON, so taking a placement away is explicit. */
    @Test
    fun `unplacing is asked for rather than inferred from an omitted field`() {
        val id = schematic().id
        val created = create("""{"name":"north tower","schematicId":$id,"placement":{"x":1,"y":2,"z":3}}""")
            .andReturn().response.contentAsString
        val build: Int = JsonPath.read(created, "$.id")

        fun patch(body: String) = mockMvc.patch("/api/builds/$build") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = body
        }

        // A rename leaves the placement exactly where it was.
        patch("""{"name":"south tower"}""").andExpect {
            status { isOk() }
            jsonPath("$.placed") { value(true) }
        }

        patch("""{"unplace":true}""").andExpect {
            status { isOk() }
            jsonPath("$.placed") { value(false) }
            jsonPath("$.placement") { doesNotExist() }
        }
    }

    @Test
    fun `substitutions are replaced wholesale and read back in a stable order`() {
        val id = schematic().id
        val created = create(
            """{"name":"cheap tower","schematicId":$id,"substitutions":[
                 {"from":"minecraft:diamond_block","to":"minecraft:stone"},
                 {"from":"minecraft:beacon","to":null}]}""",
        ).andExpect {
            status { isCreated() }
            jsonPath("$.substitutions.length()") { value(2) }
            // Sorted by source block, so what is read back is what will be read back next time.
            jsonPath("$.substitutions[0].from") { value("minecraft:beacon") }
            // Null replacement survives as null: "place nothing" is a rule, not a missing value.
            jsonPath("$.substitutions[0].to") { doesNotExist() }
        }.andReturn().response.contentAsString

        val build: Int = JsonPath.read(created, "$.id")

        mockMvc.patch("/api/builds/$build") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"substitutions":[{"from":"minecraft:gold_block","to":"minecraft:iron_block"}]}"""
        }.andExpect {
            status { isOk() }
            // Wholesale: the previous two are gone rather than merged with.
            jsonPath("$.substitutions.length()") { value(1) }
            jsonPath("$.substitutions[0].from") { value("minecraft:gold_block") }
        }
    }

    /**
     * Saving a plan twice without changing anything.
     *
     * Clearing the collection and re-adding it looks like a replacement and is not: Hibernate
     * orders inserts before deletes within one flush, so the rows going in hit the unique
     * constraint against the rows that have not gone out yet. The rule set has to be reconciled in
     * place — untouched rows keep their identity, and only what actually changed is written.
     */
    @Test
    fun `saving the same substitutions again changes nothing and fails at nothing`() {
        val id = schematic().id
        val created = create(
            """{"name":"repeatable","schematicId":$id,"substitutions":[
                 {"from":"minecraft:white_terracotta","to":"minecraft:stone"},
                 {"from":"minecraft:beacon","to":null}]}""",
        ).andReturn().response.contentAsString
        val build: Int = JsonPath.read(created, "$.id")

        fun save(body: String) = mockMvc.patch("/api/builds/$build") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = body
        }

        val same = """{"substitutions":[
             {"from":"minecraft:white_terracotta","to":"minecraft:stone"},
             {"from":"minecraft:beacon","to":null}]}"""

        save(same).andExpect { status { isOk() } }
        save(same).andExpect {
            status { isOk() }
            jsonPath("$.substitutions.length()") { value(2) }
        }

        // Changing where an existing rule points is an update, not a delete and an insert.
        save("""{"substitutions":[{"from":"minecraft:white_terracotta","to":"minecraft:cobblestone"}]}""")
            .andExpect {
                status { isOk() }
                jsonPath("$.substitutions.length()") { value(1) }
                jsonPath("$.substitutions[0].to") { value("minecraft:cobblestone") }
            }
    }

    @Test
    fun `a blank replacement is stored as nothing rather than as an empty name`() {
        val id = schematic().id

        // Two representations of "place nothing" that behaved the same but did not compare equal
        // would be a rule that looks different depending on how it was typed.
        create("""{"name":"holey","schematicId":$id,"substitutions":[{"from":"minecraft:beacon","to":"   "}]}""")
            .andExpect {
                status { isCreated() }
                jsonPath("$.substitutions[0].to") { doesNotExist() }
            }
    }

    @Test
    fun `a block cannot be substituted twice, or for itself`() {
        val id = schematic().id

        create(
            """{"name":"ambiguous","schematicId":$id,"substitutions":[
                 {"from":"minecraft:stone","to":"minecraft:dirt"},
                 {"from":"minecraft:stone","to":"minecraft:sand"}]}""",
        ).andExpect { status { isBadRequest() } }

        create(
            """{"name":"pointless","schematicId":$id,"substitutions":[
                 {"from":"minecraft:stone","to":"minecraft:stone"}]}""",
        ).andExpect { status { isBadRequest() } }
    }

    /**
     * Not transactional: the cascade is a database constraint, and inside one persistence context
     * Hibernate flushes the plan that still points at the schematic before the delete reaches the
     * database at all. Rows are cleaned up by hand instead.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `a plan goes with the schematic it plans`() {
        // Its own account, because nothing is rolling this one back: the shared one would still be
        // there when the next test tried to create it.
        val auth = authAs("planner-cascade", RoleNames.ORCHESTRATOR)
        val schematic = schematic("doomed-schematic")

        try {
            mockMvc.post("/api/builds") {
                header(HttpHeaders.AUTHORIZATION, auth)
                contentType = MediaType.APPLICATION_JSON
                content = """{"name":"doomed","schematicId":${schematic.id}}"""
            }.andExpect { status { isCreated() } }
            assertEquals(1, builds.findAll().size)

            // A plan to build a file that no longer exists cannot be carried out, and a row
            // pointing at nothing is something for somebody to discover much later.
            schematics.deleteById(schematic.id!!)
            schematics.flush()

            assertTrue(builds.findAll().isEmpty())
        } finally {
            builds.deleteAll()
            schematics.deleteAll()
        }
    }

    @Test
    fun `two builds cannot share a name`() {
        val id = schematic().id
        create("""{"name":"tower","schematicId":$id}""").andExpect { status { isCreated() } }
        create("""{"name":"tower","schematicId":$id}""").andExpect { status { isConflict() } }
    }

    @Test
    fun `the same schematic can be planned twice in two places`() {
        val id = schematic().id

        create("""{"name":"east","schematicId":$id,"placement":{"x":0,"y":64,"z":0}}""")
            .andExpect { status { isCreated() } }
        create("""{"name":"west","schematicId":$id,"placement":{"x":500,"y":64,"z":0}}""")
            .andExpect { status { isCreated() } }

        // The whole reason placement is not a column on the schematic.
        assertEquals(2, builds.findAll().size)
    }

    @Test
    fun `a viewer may read plans but not make one`() {
        val id = schematic().id

        mockMvc.get("/api/builds") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.VIEWER))
        }.andExpect { status { isOk() } }

        create("""{"name":"nope","schematicId":$id}""", user = RoleNames.VIEWER)
            .andExpect { status { isForbidden() } }
    }

    /** Deleting a plan is not the reverse of making one: the coordinates and the rules go with it. */
    @Test
    fun `an orchestrator may plan but not delete the plan`() {
        val id = schematic().id
        val created = create("""{"name":"tower","schematicId":$id}""").andReturn().response.contentAsString
        val build: Int = JsonPath.read(created, "$.id")

        mockMvc.delete("/api/builds/$build") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ORCHESTRATOR))
        }.andExpect { status { isForbidden() } }

        mockMvc.delete("/api/builds/$build") {
            header(HttpHeaders.AUTHORIZATION, asRole(RoleNames.ADMINISTRATOR))
        }.andExpect { status { isNoContent() } }
    }
}

package net.integr.osmium.storage

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.security.RoleNames
import net.integr.osmium.storage.model.StorageArea
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The storage screen's two guarantees.
 *
 * **The areas add up to the database.** A table added by a migration and named in no area would
 * otherwise vanish from a screen whose whole job is saying what is on the disk — which is why
 * `OTHER` exists and why this checks it rather than trusting the list to stay complete.
 *
 * **The trail is not purgeable.** A screen that can delete the record of its own use has a hole in
 * it shaped like somebody covering their tracks.
 */
class StorageControllerTest : AbstractRestTest() {

    @Autowired private lateinit var auditEntryRepository: AuditEntryRepository

    @Test
    fun `an administrator sees every area`() {
        mockMvc.get("/api/storage") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.ADMINISTRATOR))
        }.andExpect {
            status { isOk() }
            jsonPath("$.databaseBytes") { value(org.hamcrest.Matchers.greaterThan(0)) }
            jsonPath("$.areas.length()") { value(StorageArea.entries.size) }
        }
    }

    @Test
    fun `every table the database has belongs to exactly one area`() {
        // The sum is the promise this screen makes. `OTHER` is what keeps it true when a migration
        // adds a table nobody has classified yet, so what is asserted is that nothing is missing —
        // not that `OTHER` is empty.
        val body = mockMvc.get("/api/storage") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.ADMINISTRATOR))
        }.andReturn().response.contentAsString

        val listed = Regex("\"tables\":\\[(.*?)]").findAll(body)
            .flatMap { it.groupValues[1].split(",") }
            .map { it.trim('"') }
            .filter { it.isNotBlank() }
            .toList()

        assertEquals(listed.size, listed.distinct().size, "a table is claimed by two areas: $listed")
        assertTrue("chat_messages" in listed)
        assertTrue("flyway_schema_history" in listed, "an unclaimed table should fall to OTHER")
    }

    @Test
    fun `reading storage needs its own node`() {
        // An orchestrator runs the fleet all day; what the deployment keeps on disk is not part of
        // that, and this is a map of everything stored.
        mockMvc.get("/api/storage") {
            header(HttpHeaders.AUTHORIZATION, authAs("ora", RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `the audit trail cannot be purged`() {
        mockMvc.post("/api/storage/AUDIT/purge") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.ADMINISTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `an area with no single table of its own cannot be purged`() {
        // A schematic's cells hang off the schematic. Deleting them from here would take the blocks
        // and leave the design, which is not a state any other screen knows how to describe.
        mockMvc.post("/api/storage/SCHEMATICS/purge") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.ADMINISTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `purging is recorded even when it removed nothing`() {
        // That somebody pressed it is the fact worth keeping. A purge that matched no rows is still
        // a decision that was taken, and the trail is where it is answerable.
        mockMvc.post("/api/storage/CHAT/purge") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.ADMINISTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"keepDays":3650}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.area") { value("CHAT") }
            jsonPath("$.deleted") { value(0) }
        }

        assertTrue(auditEntryRepository.findAll().any { it.action == AuditAction.STORAGE_PURGE })
    }

    @Test
    fun `purging needs more than permission to look`() {
        mockMvc.post("/api/storage/CHAT/purge") {
            header(HttpHeaders.AUTHORIZATION, authAs("ora", RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `keeping a negative number of days is refused`() {
        mockMvc.post("/api/storage/CHAT/purge") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.ADMINISTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"keepDays":0}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }
}

package net.integr.osmium.audit.controller

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.model.AuditEntry
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.audit.service.AuditCsv
import net.integr.osmium.audit.service.AuditService
import org.hamcrest.Matchers.contains
import org.hamcrest.Matchers.hasSize
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.put
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AuditControllerTest : AbstractRestTest() {

    @Autowired private lateinit var auditEntryRepository: AuditEntryRepository
    @Autowired private lateinit var auditService: AuditService

    private fun entry(
        account: String,
        action: AuditAction,
        target: String,
        at: Instant = Instant.now(),
        detail: String? = null,
    ) = auditEntryRepository.saveAndFlush(
        AuditEntry(at = at, account = account, action = action, target = target, detail = detail),
    )

    // ---- reading -------------------------------------------------------------------------------

    @Test
    fun `an administrator reads the trail newest first`() {
        val now = Instant.now()
        entry("older", AuditAction.AGENT_CONNECT, "Mason_01", at = now.minusSeconds(120))
        entry("newer", AuditAction.AGENT_CHAT, "Mason_02", at = now)

        mockMvc.get("/api/audit") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[*].account") { value(contains("newer", "older")) }
        }
    }

    @Test
    fun `the message text is returned, since that is the point of recording chat`() {
        entry("admin", AuditAction.AGENT_CHAT, "Mason_01", detail = "hello world")

        mockMvc.get("/api/audit") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[0].detail") { value("hello world") }
        }
    }

    @Test
    fun `limit caps the page instead of failing`() {
        repeat(3) { index -> entry("admin", AuditAction.AGENT_CONNECT, "Mason_$index") }

        mockMvc.get("/api/audit?limit=2") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items") { value(hasSize<Any>(2)) }
        }
    }

    /** Out of range is clamped rather than rejected: it is a page size, not a domain value. */
    @Test
    fun `an out of range limit is clamped`() {
        entry("admin", AuditAction.AGENT_CONNECT, "Mason_01")

        mockMvc.get("/api/audit?limit=0") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items") { value(hasSize<Any>(1)) }
        }
    }

    // ---- paging --------------------------------------------------------------------------------

    /** The whole point of the cursor: everything older than the first page is still reachable. */
    @Test
    fun `the cursor walks the trail to the end without repeating or skipping`() {
        val now = Instant.now()
        repeat(5) { index ->
            entry("admin", AuditAction.AGENT_CONNECT, "Mason_$index", at = now.minusSeconds(index.toLong()))
        }

        val seen = mutableListOf<String>()
        var cursor: String? = ""
        var pages = 0

        while (cursor != null) {
            val body = mockMvc.get("/api/audit?limit=2${if (cursor.isEmpty()) "" else "&cursor=$cursor"}") {
                header(HttpHeaders.AUTHORIZATION, authAs("walker$pages", "administrator"))
            }.andExpect { status { isOk() } }.andReturn().response.contentAsString

            seen += JsonPath.read<List<String>>(body, "$.items[*].target")
            cursor = JsonPath.read<String?>(body, "$.nextCursor")
            pages++
        }

        assertEquals(listOf("Mason_0", "Mason_1", "Mason_2", "Mason_3", "Mason_4"), seen)
        assertEquals(3, pages)
    }

    /**
     * Two entries in the same instant are ordinary under concurrent commands. Without `id` breaking
     * the tie, one of them falls into the gap at a page boundary.
     */
    @Test
    fun `entries recorded in the same instant both survive a page boundary`() {
        val same = Instant.now()
        entry("admin", AuditAction.AGENT_CONNECT, "Mason_a", at = same)
        entry("admin", AuditAction.AGENT_CONNECT, "Mason_b", at = same)

        val first = mockMvc.get("/api/audit?limit=1") {
            header(HttpHeaders.AUTHORIZATION, authAs("tied", "administrator"))
        }.andReturn().response.contentAsString

        mockMvc.get("/api/audit?limit=1&cursor=${JsonPath.read<String>(first, "$.nextCursor")}") {
            header(HttpHeaders.AUTHORIZATION, authAs("tied2", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[0].target") { value("Mason_a") }
        }
    }

    @Test
    fun `a malformed cursor is rejected rather than silently starting over`() {
        mockMvc.get("/api/audit?cursor=not-a-cursor") {
            header(HttpHeaders.AUTHORIZATION, authAs("confused", "administrator"))
        }.andExpect { status { isBadRequest() } }
    }

    // ---- searching -----------------------------------------------------------------------------

    @Test
    fun `a query matches the account, the target and the detail`() {
        entry("alice", AuditAction.AGENT_CONNECT, "Mason_01")
        entry("bob", AuditAction.AGENT_CONNECT, "Spire_07")
        entry("carol", AuditAction.AGENT_CHAT, "Mason_02", detail = "bring deepslate")

        fun targets(query: String, as_: String): List<String> {
            val body = mockMvc.get("/api/audit?query=$query") {
                header(HttpHeaders.AUTHORIZATION, authAs(as_, "administrator"))
            }.andExpect { status { isOk() } }.andReturn().response.contentAsString
            return JsonPath.read(body, "$.items[*].target")
        }

        assertEquals(listOf("Mason_01"), targets("alice", "s1"))
        assertEquals(listOf("Spire_07"), targets("spire", "s2"))
        assertEquals(listOf("Mason_02"), targets("deepslate", "s3"))
    }

    /** The column stores the enum constant, so the action has to be matched by name server-side. */
    @Test
    fun `a query matches the name of the action`() {
        entry("alice", AuditAction.AGENT_CONNECT, "Mason_01")
        entry("alice", AuditAction.HOST_ROTATE_TOKEN, "host-eu-1")

        mockMvc.get("/api/audit?query=rotate") {
            header(HttpHeaders.AUTHORIZATION, authAs("searcher", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[*].target") { value(contains("host-eu-1")) }
        }
    }

    /** No action name matches, so the `in` clause is empty - which must narrow, not blow up. */
    @Test
    fun `a query matching nothing returns an empty page`() {
        entry("alice", AuditAction.AGENT_CONNECT, "Mason_01")

        mockMvc.get("/api/audit?query=zzzzz") {
            header(HttpHeaders.AUTHORIZATION, authAs("fruitless", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items") { value(hasSize<Any>(0)) }
            jsonPath("$.nextCursor") { value(null as String?) }
        }
    }

    /** Otherwise a search for a literal `%` would quietly match the whole trail. */
    @Test
    fun `like wildcards in a query are searched for literally`() {
        entry("alice", AuditAction.AGENT_CONNECT, "Mason_01")
        entry("alice", AuditAction.AGENT_CHAT, "Mason_02", detail = "100% done")

        mockMvc.get("/api/audit") {
            header(HttpHeaders.AUTHORIZATION, authAs("literal", "administrator"))
            param("query", "%")
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[*].target") { value(contains("Mason_02")) }
        }
    }

    // ---- export --------------------------------------------------------------------------------

    private fun exportAs(account: String, role: String = "administrator", from: String, to: String) =
        mockMvc.get("/api/audit/export") {
            header(HttpHeaders.AUTHORIZATION, authAs(account, role))
            param("from", from)
            param("to", to)
        }

    @Test
    fun `the export is a csv attachment named for its range`() {
        entry("alice", AuditAction.AGENT_CONNECT, "Mason_01", at = Instant.parse("2026-07-20T10:00:00Z"))

        exportAs("exporter", from = "2026-07-01T00:00:00Z", to = "2026-08-01T00:00:00Z").andExpect {
            status { isOk() }
            header { string(HttpHeaders.CONTENT_TYPE, AuditCsv.CONTENT_TYPE) }
            header {
                string(
                    HttpHeaders.CONTENT_DISPOSITION,
                    "attachment; filename=\"osmium-audit-2026-07-01-to-2026-08-01.csv\"",
                )
            }
            content { string(org.hamcrest.Matchers.startsWith("at,account,action,target,detail\r\n")) }
            content { string(org.hamcrest.Matchers.containsString("\"Mason_01\"")) }
        }
    }

    /** `from` inclusive, `to` exclusive, so consecutive ranges neither overlap nor leave a gap. */
    @Test
    fun `the range includes from and excludes to`() {
        entry("boundary", AuditAction.AGENT_CONNECT, "on_from", at = Instant.parse("2026-07-01T00:00:00Z"))
        entry("boundary", AuditAction.AGENT_CONNECT, "inside", at = Instant.parse("2026-07-15T00:00:00Z"))
        entry("boundary", AuditAction.AGENT_CONNECT, "on_to", at = Instant.parse("2026-08-01T00:00:00Z"))

        val body = exportAs("edges", from = "2026-07-01T00:00:00Z", to = "2026-08-01T00:00:00Z")
            .andExpect { status { isOk() } }.andReturn().response.contentAsString

        assertTrue(body.contains("\"on_from\""))
        assertTrue(body.contains("\"inside\""))
        assertTrue(!body.contains("\"on_to\""))
    }

    @Test
    fun `the export records who took a copy, and of what`() {
        entry("alice", AuditAction.AGENT_CONNECT, "Mason_01", at = Instant.parse("2026-07-20T10:00:00Z"))

        exportAs("taker", from = "2026-07-01T00:00:00Z", to = "2026-08-01T00:00:00Z")
            .andExpect { status { isOk() } }

        val recorded = auditEntryRepository.findAll().single { it.action == AuditAction.AUDIT_EXPORT }
        assertEquals("taker", recorded.account)
        assertTrue(recorded.target.startsWith("2026-07-01T00:00:00Z.."))
        assertEquals("1 entries", recorded.detail)
    }

    /**
     * The record is written before the rows are sent, so it lands in the trail being read. Capping
     * the range at the moment the export started keeps it out of its own file — and keeps the count
     * in the record equal to the rows actually written.
     */
    @Test
    fun `an export covering now does not contain its own record`() {
        entry("alice", AuditAction.AGENT_CONNECT, "Mason_01", at = Instant.now().minusSeconds(60))

        val body = exportAs(
            "recursive",
            from = Instant.now().minusSeconds(3600).toString(),
            to = Instant.now().plusSeconds(3600).toString(),
        ).andExpect { status { isOk() } }.andReturn().response.contentAsString

        assertTrue(body.contains("\"Mason_01\""))
        assertTrue(!body.contains("AUDIT_EXPORT"))
        assertEquals(1, auditEntryRepository.findAll().count { it.action == AuditAction.AUDIT_EXPORT })
    }

    /** RFC 4180: a quote doubles, and a comma or newline is why every field is quoted at all. */
    @Test
    fun `a comma, a quote and a newline survive the round trip`() {
        entry(
            "alice",
            AuditAction.AGENT_CHAT,
            "Mason_01",
            at = Instant.parse("2026-07-20T10:00:00Z"),
            detail = "say \"hi\", then\nleave",
        )

        val body = exportAs("quoting", from = "2026-07-01T00:00:00Z", to = "2026-08-01T00:00:00Z")
            .andExpect { status { isOk() } }.andReturn().response.contentAsString

        assertTrue(body.contains("\"say \"\"hi\"\", then\nleave\""))
    }

    /**
     * `detail` carries in-game chat, which is written by whoever is on the Minecraft server. Without
     * this, a player typing a formula into chat gets it run when an administrator opens the export.
     */
    @Test
    fun `a detail a spreadsheet would run as a formula is neutralised`() {
        entry(
            "alice",
            AuditAction.AGENT_CHAT,
            "Mason_01",
            at = Instant.parse("2026-07-20T10:00:00Z"),
            detail = "=HYPERLINK(\"http://evil.example\")",
        )

        val body = exportAs("formula", from = "2026-07-01T00:00:00Z", to = "2026-08-01T00:00:00Z")
            .andExpect { status { isOk() } }.andReturn().response.contentAsString

        assertTrue(body.contains("\"'=HYPERLINK("))
    }

    @Test
    fun `a range that does not move forward is rejected`() {
        exportAs("backwards", from = "2026-08-01T00:00:00Z", to = "2026-07-01T00:00:00Z")
            .andExpect { status { isBadRequest() } }
    }

    /** Separate node, so reading the trail in the UI does not carry the right to take it away. */
    @Test
    fun `an orchestrator cannot export the trail`() {
        exportAs("orch", role = "orchestrator", from = "2026-07-01T00:00:00Z", to = "2026-08-01T00:00:00Z")
            .andExpect { status { isForbidden() } }
    }

    @Test
    fun `an anonymous export is rejected`() {
        mockMvc.get("/api/audit/export") {
            param("from", "2026-07-01T00:00:00Z")
            param("to", "2026-08-01T00:00:00Z")
        }.andExpect { status { isUnauthorized() } }
    }

    // ---- authorization -------------------------------------------------------------------------

    @Test
    fun `an anonymous request is rejected`() {
        mockMvc.get("/api/audit").andExpect { status { isUnauthorized() } }
    }

    /**
     * The point of putting audit.read outside the fleet.* tier: an orchestrator has total authority
     * over the fleet and still cannot read what other operators did.
     */
    @Test
    fun `an orchestrator cannot read the trail`() {
        mockMvc.get("/api/audit") {
            header(HttpHeaders.AUTHORIZATION, authAs("orchestrator", "orchestrator"))
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `a viewer cannot read the trail`() {
        mockMvc.get("/api/audit") {
            header(HttpHeaders.AUTHORIZATION, authAs("viewer", "viewer"))
        }.andExpect { status { isForbidden() } }
    }

    // ---- recording -----------------------------------------------------------------------------

    /**
     * A command that fails leaves no trace, because the entry is written inside the command's own
     * transaction. Nothing happened, so there is nothing to hold anyone to.
     */
    @Test
    fun `an undeliverable command records nothing`() {
        val agent = createAgent("Mason_02", unreachableHost(), state = AgentState.LINKED)

        mockMvc.post("/api/agents/${agent.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, authAs("operator", "orchestrator"))
        }.andExpect { status { isServiceUnavailable() } }

        assertEquals(0, auditEntryRepository.count())
    }

    @Test
    fun `enrolling a host is recorded`() {
        mockMvc.post("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, authAs("enroller", "orchestrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-9"}"""
        }.andExpect { status { isCreated() } }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals(AuditAction.HOST_ENROL, recorded.action)
        assertEquals("host-eu-9", recorded.target)
        assertEquals("enroller", recorded.account)
    }

    @Test
    fun `rotating a token is recorded`() {
        val host = reachableHost("host-eu-8")

        mockMvc.post("/api/hosts/${host.id}/rotate-token") {
            header(HttpHeaders.AUTHORIZATION, authAs("rotator", "orchestrator"))
        }.andExpect { status { isOk() } }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals(AuditAction.HOST_ROTATE_TOKEN, recorded.action)
        assertEquals("host-eu-8", recorded.target)
    }

    /** Recorded by name, not id: the entry has to stay readable once the host is gone. */
    @Test
    fun `deleting a host is recorded after the host no longer exists`() {
        val host = reachableHost("host-eu-7")
        createAgent("Mason_09", host)

        mockMvc.delete("/api/hosts/${host.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("remover", "orchestrator"))
        }.andExpect { status { isNoContent() } }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals(AuditAction.HOST_DELETE, recorded.action)
        assertEquals("host-eu-7", recorded.target)
        assertTrue(recorded.detail!!.contains("1 agent"))
    }

    @Test
    fun `creating an agent is recorded with its host and server`() {
        val host = reachableHost("host-eu-6")

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, authAs("builder", "orchestrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_20","hostId":${host.id},"serverAddress":"mc.example.com"}"""
        }.andExpect { status { isCreated() } }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals(AuditAction.AGENT_CREATE, recorded.action)
        assertEquals("Mason_20", recorded.target)
        assertTrue(recorded.detail!!.contains("host-eu-6"))
    }

    @Test
    fun `moving an agent to another server records where it came from`() {
        val agent = createAgent("Mason_21", reachableHost(), server = "old.example.com:25565")

        mockMvc.put("/api/agents/${agent.id}/server") {
            header(HttpHeaders.AUTHORIZATION, authAs("mover", "orchestrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"new.example.com"}"""
        }.andExpect { status { isOk() } }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals(AuditAction.AGENT_UPDATE, recorded.action)
        assertTrue(recorded.detail!!.contains("old.example.com:25565"))
    }

    /** Unassigning is a change worth recording too, and the entry has to say what was given up. */
    @Test
    fun `unassigning an agent records the server it left`() {
        val agent = createAgent("Mason_22", reachableHost(), server = "old.example.com:25565")

        mockMvc.put("/api/agents/${agent.id}/server") {
            header(HttpHeaders.AUTHORIZATION, authAs("mover", "orchestrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":null}"""
        }.andExpect { status { isOk() } }

        val recorded = auditEntryRepository.findAll().single()
        assertTrue(recorded.detail!!.contains("unassigned from old.example.com:25565"))
    }

    /** A patch that changes nothing is a no-op, and a "was edited into its own shape" row is noise. */
    @Test
    fun `an edit that changes nothing records nothing`() {
        val agent = createAgent("Mason_22", reachableHost(), server = "mc.example.com:25565")

        mockMvc.patch("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("idle", "orchestrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_22"}"""
        }.andExpect { status { isOk() } }

        assertEquals(0, auditEntryRepository.count())
    }

    @Test
    fun `a role change records both sides of it`() {
        val subject = createUser("promoted", role = "viewer")

        mockMvc.put("/api/users/${subject.id}/role") {
            header(HttpHeaders.AUTHORIZATION, authAs("granter", "administrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"role":"orchestrator"}"""
        }.andExpect { status { isOk() } }

        val recorded = auditEntryRepository.findAll().single { it.action == AuditAction.USER_ROLE_CHANGE }
        assertEquals("promoted", recorded.target)
        assertEquals("viewer → orchestrator", recorded.detail)
        assertEquals("granter", recorded.account)
    }

    @Test
    fun `deleting an account records the role it held`() {
        val subject = createUser("doomed", role = "orchestrator")

        mockMvc.delete("/api/users/${subject.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("remover2", "administrator"))
        }.andExpect { status { isNoContent() } }

        val recorded = auditEntryRepository.findAll().single { it.action == AuditAction.USER_DELETE }
        assertEquals("doomed", recorded.target)
        assertTrue(recorded.detail!!.contains("orchestrator"))
    }

    /**
     * The one entry that must never leak what it describes. An administrator resetting someone
     * else's password is worth recording; the password itself is not.
     */
    @Test
    fun `a password reset is recorded without the password`() {
        val subject = createUser("resettable", role = "viewer")

        mockMvc.patch("/api/users/${subject.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("resetter", "administrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"resettable","password":"hunter2-and-then-some"}"""
        }.andExpect { status { isOk() } }

        val recorded = auditEntryRepository.findAll().single { it.action == AuditAction.USER_UPDATE }
        assertTrue(recorded.detail!!.contains("password reset"))
        assertTrue(auditEntryRepository.findAll().none { it.detail?.contains("hunter2") == true })
    }

    @Test
    fun `changing your own password is recorded without either password`() {
        createUser("rotator2", role = "viewer")

        mockMvc.post("/api/auth/password") {
            header(HttpHeaders.AUTHORIZATION, bearer(tokenFor("rotator2")))
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"$DEFAULT_PASSWORD","newPassword":"a-different-one"}"""
        }.andExpect { status { isNoContent() } }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals(AuditAction.USER_PASSWORD_CHANGE, recorded.action)
        assertEquals("rotator2", recorded.target)
        assertTrue(auditEntryRepository.findAll().none { it.detail?.contains("a-different-one") == true })
    }

    /** The account comes from the security context rather than a threaded-through parameter. */
    @Test
    fun `a recorded entry names the authenticated account and truncates long detail`() {
        val principal = UsernamePasswordAuthenticationToken("scribe", null, emptyList())
        SecurityContextHolder.getContext().authentication = principal
        try {
            auditService.record(AuditAction.AGENT_CHAT, "Mason_03", "x".repeat(AuditEntry.DETAIL_MAX + 50))
        } finally {
            SecurityContextHolder.clearContext()
        }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals("scribe", recorded.account)
        assertEquals(AuditEntry.DETAIL_MAX, recorded.detail!!.length)
    }

    // ---- retention -----------------------------------------------------------------------------

    /**
     * Not transactional: the purge issues a bulk delete, and asserting on it inside a rolled-back
     * transaction would measure the persistence context rather than the table.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `the purge drops entries past their retention and keeps the rest`() {
        auditEntryRepository.deleteAll()
        val stale = entry("old", AuditAction.AGENT_CONNECT, "Mason_old", at = Instant.now().minus(31, ChronoUnit.DAYS))
        val fresh = entry("new", AuditAction.AGENT_CONNECT, "Mason_new", at = Instant.now().minus(29, ChronoUnit.DAYS))

        auditService.purgeExpired()

        val remaining = auditEntryRepository.findAll().map { it.id }
        assertEquals(listOf(fresh.id), remaining)
        assertTrue(stale.id !in remaining)

        auditEntryRepository.deleteAll()
    }
}

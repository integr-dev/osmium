package net.integr.osmium.audit.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.model.AuditEntry
import net.integr.osmium.audit.repository.AuditEntryRepository
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
            jsonPath("$[*].account") { value(contains("newer", "older")) }
        }
    }

    @Test
    fun `the message text is returned, since that is the point of recording chat`() {
        entry("admin", AuditAction.AGENT_CHAT, "Mason_01", detail = "hello world")

        mockMvc.get("/api/audit") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].detail") { value("hello world") }
        }
    }

    @Test
    fun `limit caps the page instead of failing`() {
        repeat(3) { index -> entry("admin", AuditAction.AGENT_CONNECT, "Mason_$index") }

        mockMvc.get("/api/audit?limit=2") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "administrator"))
        }.andExpect {
            status { isOk() }
            jsonPath("$") { value(hasSize<Any>(2)) }
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
            jsonPath("$") { value(hasSize<Any>(1)) }
        }
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

        mockMvc.patch("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("mover", "orchestrator"))
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"new.example.com"}"""
        }.andExpect { status { isOk() } }

        val recorded = auditEntryRepository.findAll().single()
        assertEquals(AuditAction.AGENT_UPDATE, recorded.action)
        assertTrue(recorded.detail!!.contains("old.example.com:25565"))
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

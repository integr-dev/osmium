package net.integr.osmium.account.controller

import com.jayway.jsonpath.JsonPath
import jakarta.servlet.http.Cookie
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.account.repository.RefreshTokenRepository
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.security.RefreshCookie
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The session lifecycle: a short-lived access token in the body, a refresh token in a cookie the
 * browser's JavaScript cannot read, and rotation that turns a stolen token into a detectable one.
 */
class SessionRefreshTest : AbstractRestTest() {

    @Autowired private lateinit var refreshTokenRepository: RefreshTokenRepository
    @Autowired private lateinit var auditEntryRepository: AuditEntryRepository

    // ---- login ---------------------------------------------------------------------------------

    @Test
    fun `login sets a refresh cookie that scripts cannot read`() {
        createUser(username = "ada", role = RoleNames.VIEWER)

        val response = signIn("ada")
        val cookie = assertNotNull(response.getCookie(RefreshCookie.NAME), "no refresh cookie was set")

        assertTrue(cookie.isHttpOnly, "the refresh cookie must be HttpOnly - that is the whole point")
        // Scoped to the three endpoints that need it, so it is not on the wire for ordinary calls.
        assertEquals("/api/auth", cookie.path)
        // `Secure` is deliberately absent here: it is configurable and off for development. See
        // RefreshCookieTest, which pins the attribute itself.

        val header = assertNotNull(response.getHeader(HttpHeaders.SET_COOKIE))
        // Refresh and logout are authenticated by this cookie alone, so a cross-site POST must not
        // carry it. Not exposed on the Cookie object, hence the raw header.
        assertTrue(header.contains("SameSite=Strict"), "expected SameSite=Strict in: $header")
    }

    @Test
    fun `the access token is not the refresh token`() {
        createUser(username = "ada", role = RoleNames.VIEWER)

        val response = signIn("ada")

        // The body carries a JWT for JavaScript; the cookie carries an opaque value it never sees.
        assertNotEquals(accessToken(response), refreshCookie(response).value)
    }

    // ---- refreshing ----------------------------------------------------------------------------

    @Test
    fun `the cookie alone buys a new access token`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")

        // No Authorization header: the case this exists for is the one where it has expired.
        val refreshed = mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(session))
        }.andExpect { status { isOk() } }.andReturn().response

        val token = accessToken(refreshed)
        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, bearer(token))
        }.andExpect {
            status { isOk() }
            jsonPath("$.username") { value("ada") }
        }
    }

    @Test
    fun `refreshing rotates the cookie`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")

        val refreshed = refresh(session)

        assertNotEquals(refreshCookie(session).value, refreshCookie(refreshed).value)
    }

    @Test
    fun `refreshing does not extend the session past its login`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")
        val issuedAt = refreshTokenRepository.findAll().single().expiresAt

        refresh(session)

        // Fixed, not sliding: the successor inherits the expiry rather than taking a new one, so an
        // operator signs in again on the same schedule however much they use the app.
        val expiries = refreshTokenRepository.findAll().map { it.expiresAt }.distinct()
        assertEquals(listOf(issuedAt), expiries)
    }

    @Test
    fun `a request with no cookie is refused`() {
        mockMvc.post("/api/auth/refresh").andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `a token that never existed is refused`() {
        mockMvc.post("/api/auth/refresh") {
            cookie(Cookie(RefreshCookie.NAME, "not-a-token"))
        }.andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `an expired token is refused`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")

        refreshTokenRepository.findAll().single().apply {
            expiresAt = Instant.now().minusSeconds(1)
            refreshTokenRepository.saveAndFlush(this)
        }

        mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(session))
        }.andExpect { status { isUnauthorized() } }
    }

    // ---- theft ---------------------------------------------------------------------------------

    /**
     * **Not transactional, and that is the whole point.**
     *
     * Refusing a replay means throwing, and a throw rolls back the transaction it happened in — so
     * the revocation has to commit in a transaction of its own or it goes back with the exception.
     * Inside the suite's usual rolled-back transaction that distinction is invisible: nothing ever
     * commits, so a revocation that would be undone in production still reads as applied here. This
     * test passed against the broken version, and a manual run against a live backend is what
     * caught it. Cleanup is explicit, since there is no rollback to do it.
     */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `replaying a spent token is refused and takes the whole session with it`() {
        try {
            createUser(username = "replayed", role = RoleNames.VIEWER)
            val session = signIn("replayed")
            val successor = refresh(session)

            // The legitimate holder replaces its cookie and never presents the old value again, so
            // a second presentation means a copy is in circulation.
            mockMvc.post("/api/auth/refresh") {
                cookie(refreshCookie(session))
            }.andExpect { status { isUnauthorized() } }

            // And the successor dies with it. There is no way to tell whether the replay came from
            // the thief or the victim, so the only safe answer is to end it for both.
            mockMvc.post("/api/auth/refresh") {
                cookie(refreshCookie(successor))
            }.andExpect { status { isUnauthorized() } }
        } finally {
            cleanUpReplayed()
        }
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `reuse is written to the audit trail, naming the account it happened to`() {
        try {
            createUser(username = "replayed", role = RoleNames.VIEWER)
            val session = signIn("replayed")
            refresh(session)

            mockMvc.post("/api/auth/refresh") { cookie(refreshCookie(session)) }

            val entry = auditEntryRepository.findAll()
                .single { it.action == AuditAction.SESSION_REUSE_DETECTED }
            assertEquals("replayed", entry.target)
        } finally {
            cleanUpReplayed()
        }
    }

    /** No rollback to lean on, so the two committing tests tidy up after themselves. */
    private fun cleanUpReplayed() {
        auditEntryRepository.deleteAll(
            auditEntryRepository.findAll().filter { it.action == AuditAction.SESSION_REUSE_DETECTED },
        )
        userRepository.findByUsername("replayed")?.let { userRepository.delete(it) }
    }

    // ---- ending a session ----------------------------------------------------------------------

    @Test
    fun `logout revokes the session and clears the cookie`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")

        val response = mockMvc.post("/api/auth/logout") {
            cookie(refreshCookie(session))
        }.andExpect { status { isNoContent() } }.andReturn().response

        assertEquals(0, assertNotNull(response.getCookie(RefreshCookie.NAME)).maxAge, "cookie not cleared")

        mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(session))
        }.andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `logging out without a session still clears the cookie`() {
        // Reporting failure here would leave the operator holding a cookie they cannot get rid of.
        mockMvc.post("/api/auth/logout").andExpect { status { isNoContent() } }
    }

    @Test
    fun `changing the password ends every session the account has`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")
        val token = accessToken(session)

        mockMvc.post("/api/auth/password") {
            header(HttpHeaders.AUTHORIZATION, bearer(token))
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"$DEFAULT_PASSWORD","newPassword":"a-new-one"}"""
        }.andExpect { status { isNoContent() } }

        // The point of changing a password after a scare is that whoever had the old one is locked
        // out. Sessions opened with it surviving would be that point missed.
        mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(session))
        }.andExpect { status { isUnauthorized() } }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private fun signIn(username: String): MockHttpServletResponse =
        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"$username","password":"$DEFAULT_PASSWORD"}"""
        }.andExpect { status { isOk() } }.andReturn().response

    private fun refresh(session: MockHttpServletResponse): MockHttpServletResponse =
        mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(session))
        }.andExpect { status { isOk() } }.andReturn().response

    private fun refreshCookie(response: MockHttpServletResponse): Cookie =
        assertNotNull(response.getCookie(RefreshCookie.NAME), "no refresh cookie on the response")

    private fun accessToken(response: MockHttpServletResponse): String =
        JsonPath.read(response.contentAsString, "$.token")
}

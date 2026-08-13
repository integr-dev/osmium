package net.integr.osmium.account.controller

import com.jayway.jsonpath.JsonPath
import jakarta.servlet.http.Cookie
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.security.RefreshCookie
import net.integr.osmium.security.RoleNames
import org.hamcrest.Matchers.hasSize
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * What an operator can do once they believe a session has been stolen.
 *
 * The two halves are separate for a reason. Revoking refresh tokens stops an attacker *renewing*,
 * but the access token they already hold is a stateless JWT that keeps working until it expires —
 * so a "sign out everywhere" that only did the first would leave a working session behind for half
 * an hour, which is precisely the window someone is trying to close.
 */
class SessionVisibilityTest : AbstractRestTest() {

    @Autowired private lateinit var auditEntryRepository: AuditEntryRepository

    // ---- listing -------------------------------------------------------------------------------

    @Test
    fun `an operator sees their own sessions, and which one they are using`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")

        mockMvc.get("/api/auth/sessions") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(session)))
            cookie(refreshCookie(session))
        }.andExpect {
            status { isOk() }
            jsonPath("$") { value(hasSize<Any>(1)) }
            jsonPath("$[0].current") { value(true) }
        }
    }

    @Test
    fun `signing in twice is two sessions, and only the caller's is marked current`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val first = signIn("ada")
        val second = signIn("ada")

        mockMvc.get("/api/auth/sessions") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(second)))
            cookie(refreshCookie(second))
        }.andExpect {
            status { isOk() }
            jsonPath("$") { value(hasSize<Any>(2)) }
            // Newest first, and the one holding this cookie is the current one.
            jsonPath("$[0].current") { value(true) }
            jsonPath("$[1].current") { value(false) }
        }

        // The other browser is a session too, and knows itself as the current one.
        mockMvc.get("/api/auth/sessions") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(first)))
            cookie(refreshCookie(first))
        }.andExpect { jsonPath("$[1].current") { value(true) } }
    }

    @Test
    fun `the list never carries the token itself`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")
        val cookieValue = refreshCookie(session).value

        val body = mockMvc.get("/api/auth/sessions") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(session)))
            cookie(refreshCookie(session))
        }.andReturn().response.contentAsString

        // The cookie is HttpOnly precisely so its value never reaches JavaScript. Handing it back
        // in a list of sessions would undo that for the sake of a checkmark.
        assertTrue(cookieValue !in body, "the response carried the refresh token")
    }

    @Test
    fun `a spent link in a rotation chain is not a session`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")
        val refreshed = refresh(session)

        mockMvc.get("/api/auth/sessions") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(refreshed)))
            cookie(refreshCookie(refreshed))
        }.andExpect {
            status { isOk() }
            // Twenty-four refreshes a day would otherwise bury the one row that matters.
            jsonPath("$") { value(hasSize<Any>(1)) }
        }
    }

    // ---- ending one ----------------------------------------------------------------------------

    @Test
    fun `ending another of your sessions stops it refreshing`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val doomed = signIn("ada")
        val keeper = signIn("ada")

        val id = sessionIds(keeper).last()
        mockMvc.delete("/api/auth/sessions/$id") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(keeper)))
            cookie(refreshCookie(keeper))
        }.andExpect { status { isNoContent() } }

        mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(doomed))
        }.andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `another account's session cannot be ended by counting upwards`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        createUser(username = "bob", role = RoleNames.VIEWER)
        val ada = signIn("ada")
        val bob = signIn("bob")
        val adasSession = sessionIds(ada).single()

        // Reported exactly as a session that does not exist: an id is a guessable integer, and the
        // difference between the two answers would be a directory of everyone else's sessions.
        mockMvc.delete("/api/auth/sessions/$adasSession") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(bob)))
            cookie(refreshCookie(bob))
        }.andExpect { status { isNotFound() } }

        mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(ada))
        }.andExpect { status { isOk() } }
    }

    // ---- signing out everywhere ----------------------------------------------------------------

    @Test
    fun `signing out everywhere kills the access token, not only the refresh token`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")
        val token = accessToken(session)

        mockMvc.post("/api/auth/sessions/revoke-all") {
            header(HttpHeaders.AUTHORIZATION, bearer(token))
        }.andExpect { status { isNoContent() } }

        // The half that a password change alone never did. Without the cutoff this token keeps
        // working for the rest of its lifetime, which is the window somebody is trying to close.
        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, bearer(token))
        }.andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `signing out everywhere ends other sessions too`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val elsewhere = signIn("ada")
        val here = signIn("ada")

        mockMvc.post("/api/auth/sessions/revoke-all") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(here)))
        }.andExpect { status { isNoContent() } }

        mockMvc.post("/api/auth/refresh") {
            cookie(refreshCookie(elsewhere))
        }.andExpect { status { isUnauthorized() } }
    }

    @Test
    fun `it is recorded, because the moment somebody realised is what an investigation looks for`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")

        mockMvc.post("/api/auth/sessions/revoke-all") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(session)))
        }

        val entry = auditEntryRepository.findAll().single { it.action == AuditAction.SESSION_REVOKED_ALL }
        assertEquals("ada", entry.target)
    }

    @Test
    fun `a fresh sign-in after signing out everywhere works immediately`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")

        mockMvc.post("/api/auth/sessions/revoke-all") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(session)))
        }

        // The cutoff is compared strictly, so a token minted in the same second as the revocation
        // survives. Rejecting equality would make signing back in fail for up to a second.
        val fresh = signIn("ada")
        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(fresh)))
        }.andExpect { status { isOk() } }
    }

    @Test
    fun `changing a password also kills tokens already issued`() {
        createUser(username = "ada", role = RoleNames.VIEWER)
        val session = signIn("ada")
        val token = accessToken(session)

        mockMvc.post("/api/auth/password") {
            header(HttpHeaders.AUTHORIZATION, bearer(token))
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"$DEFAULT_PASSWORD","newPassword":"a-new-one"}"""
        }.andExpect { status { isNoContent() } }

        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, bearer(token))
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

    private fun sessionIds(session: MockHttpServletResponse): List<Int> {
        val body = mockMvc.get("/api/auth/sessions") {
            header(HttpHeaders.AUTHORIZATION, bearer(accessToken(session)))
            cookie(refreshCookie(session))
        }.andReturn().response.contentAsString
        return JsonPath.read(body, "$[*].id")
    }

    private fun refreshCookie(response: MockHttpServletResponse): Cookie =
        assertNotNull(response.getCookie(RefreshCookie.NAME), "no refresh cookie on the response")

    private fun accessToken(response: MockHttpServletResponse): String =
        JsonPath.read(response.contentAsString, "$.token")
}

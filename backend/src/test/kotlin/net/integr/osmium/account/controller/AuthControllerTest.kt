package net.integr.osmium.account.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.security.Nodes
import net.integr.osmium.security.RoleNames
import org.hamcrest.Matchers.contains
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post

class AuthControllerTest : AbstractRestTest() {

    @Test
    fun `login issues a token for valid credentials`() {
        createUser(username = "ada", role = RoleNames.VIEWER)

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"ada","password":"$DEFAULT_PASSWORD"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.token") { isNotEmpty() }
            jsonPath("$.expiresAt") { isNotEmpty() }
        }
    }

    @Test
    fun `login rejects a wrong password`() {
        createUser(username = "ada")

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"ada","password":"nope"}"""
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `login rejects an unknown username`() {
        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"ghost","password":"$DEFAULT_PASSWORD"}"""
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `me returns the authenticated account with its flattened nodes`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)

        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.username") { value("ada") }
            jsonPath("$.role") { value(RoleNames.ORCHESTRATOR) }
            jsonPath("$.nodes") { value(
                contains(
                    "activity.read",
                    "agent.read",
                    "agent.run",
                    "agent.setup",
                    "agent.write",
                    "chat.read",
                    "chat.speak",
                    "host.read",
                    "host.token",
                    "host.write",
                    "role.read",
                    "schematic.read",
                    "schematic.write",
                    "user.edit.self",
                    "user.read.self",
                ),
            ) }
        }
    }

    @Test
    fun `me rejects a request without a token`() {
        mockMvc.get("/api/auth/me").andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `me rejects a garbage token`() {
        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, "Bearer not-a-jwt")
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `an account with no role is forbidden, not unauthenticated`() {
        val auth = authAs("ada")

        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `a deleted account's token stops authenticating`() {
        val user = createUser(username = "ada", role = RoleNames.VIEWER)
        val auth = bearer(tokenFor(username = "ada"))

        userRepository.delete(user)
        userRepository.flush()

        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `password change swaps the credentials`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.post("/api/auth/password") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"$DEFAULT_PASSWORD","newPassword":"battery-staple"}"""
        }.andExpect {
            status { isNoContent() }
        }

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"ada","password":"battery-staple"}"""
        }.andExpect {
            status { isOk() }
        }

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"ada","password":"$DEFAULT_PASSWORD"}"""
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `password change rejects a wrong current password`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.post("/api/auth/password") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"wrong","newPassword":"battery-staple"}"""
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `password change rejects reusing the current password`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.post("/api/auth/password") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"$DEFAULT_PASSWORD","newPassword":"$DEFAULT_PASSWORD"}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `password change rejects a password past the bcrypt limit`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.post("/api/auth/password") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"$DEFAULT_PASSWORD","newPassword":"${"x".repeat(73)}"}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `password change rejects an unauthenticated request`() {
        mockMvc.post("/api/auth/password") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"currentPassword":"a","newPassword":"battery-staple"}"""
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `bootstrap account is a full administrator from the first boot`() {
        val auth = bearer(tokenFor(username = BOOTSTRAP_USERNAME, password = BOOTSTRAP_PASSWORD))

        mockMvc.get("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
        }

        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.username") { value(BOOTSTRAP_USERNAME) }
            jsonPath("$.role") { value(RoleNames.ADMINISTRATOR) }
            jsonPath("$.nodes") { value(contains(*Nodes.ALL.sorted().toTypedArray())) }
        }
    }
}

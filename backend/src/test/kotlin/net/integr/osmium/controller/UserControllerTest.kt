package net.integr.osmium.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.security.RoleNames
import org.hamcrest.Matchers.contains
import org.hamcrest.Matchers.containsString
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.put

class UserControllerTest : AbstractRestTest() {

    @Test
    fun `administrator lists accounts`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.get("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$[?(@.username == 'root')]") { isNotEmpty() }
        }
    }

    @Test
    fun `viewer cannot list accounts`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.get("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `listing accounts rejects an unauthenticated request`() {
        mockMvc.get("/api/users").andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `administrator creates an account that can log in`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.post("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"hopper-1906","role":"viewer"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.username") { value("grace") }
            jsonPath("$.role") { value(RoleNames.VIEWER) }
        }

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"hopper-1906"}"""
        }.andExpect {
            status { isOk() }
        }
    }

    @Test
    fun `creating an account rejects a duplicate username`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        createUser(username = "grace")

        mockMvc.post("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"hopper-1906"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `creating an account rejects an unknown role`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.post("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"hopper-1906","role":"wizard"}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `creating an account rejects a short password`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.post("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"x"}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `creating an account rejects a blank username`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.post("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"   ","password":"hopper-1906"}"""
        }.andExpect {
            status { isBadRequest() }
            jsonPath("$.message") { value(containsString("username")) }
        }
    }

    @Test
    fun `orchestrator cannot create an account`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)

        mockMvc.post("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"hopper-1906"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `viewer renames their own account`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.patch("/api/users/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"ada-lovelace"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.username") { value("ada-lovelace") }
        }

        // The token's subject no longer resolves, so it stops authenticating.
        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `orchestrator inherits the viewer self-edit node`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)

        mockMvc.patch("/api/users/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"bot-two"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.username") { value("bot-two") }
        }
    }

    @Test
    fun `renaming yourself rejects a taken username`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        createUser(username = "grace")

        mockMvc.patch("/api/users/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `viewer cannot edit somebody else`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val victim = createUser(username = "grace")

        mockMvc.patch("/api/users/${victim.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"pwned"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `orchestrator cannot edit somebody else`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val victim = createUser(username = "grace")

        mockMvc.patch("/api/users/${victim.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"pwned"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `administrator renames another account`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val target = createUser(username = "grace", role = RoleNames.VIEWER)

        mockMvc.patch("/api/users/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace-hopper"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.username") { value("grace-hopper") }
            jsonPath("$.role") { value(RoleNames.VIEWER) }
        }
    }

    @Test
    fun `administrator resets another account's password without the old one`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val target = createUser(username = "grace")

        mockMvc.patch("/api/users/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"reset-by-admin"}"""
        }.andExpect {
            status { isOk() }
        }

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"reset-by-admin"}"""
        }.andExpect {
            status { isOk() }
        }

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace","password":"$DEFAULT_PASSWORD"}"""
        }.andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `editing an account leaves the password alone when none is supplied`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val target = createUser(username = "grace")

        mockMvc.patch("/api/users/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace-hopper"}"""
        }.andExpect {
            status { isOk() }
        }

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"grace-hopper","password":"$DEFAULT_PASSWORD"}"""
        }.andExpect {
            status { isOk() }
        }
    }

    @Test
    fun `administrator cannot edit their own account through the admin route`() {
        val actor = createUser(username = "root", role = RoleNames.ADMINISTRATOR)
        val auth = bearer(tokenFor(username = "root"))

        mockMvc.patch("/api/users/${actor.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"root","password":"bypassed-the-check"}"""
        }.andExpect {
            status { isConflict() }
        }

        // The password must be unchanged: the admin route is not a way around /api/auth/password.
        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"root","password":"bypassed-the-check"}"""
        }.andExpect {
            status { isUnauthorized() }
        }

        mockMvc.post("/api/auth/login") {
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"root","password":"$DEFAULT_PASSWORD"}"""
        }.andExpect {
            status { isOk() }
        }
    }

    @Test
    fun `editing an unknown account returns not found`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.patch("/api/users/999999") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"nobody"}"""
        }.andExpect {
            status { isNotFound() }
        }
    }

    @Test
    fun `administrator deletes an account`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val victim = createUser(username = "grace")

        mockMvc.delete("/api/users/${victim.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNoContent() }
        }

        assertNull(userRepository.findByUsername("grace"))
    }

    @Test
    fun `administrator cannot delete their own account`() {
        val actor = createUser(username = "root", role = RoleNames.ADMINISTRATOR)
        val auth = bearer(tokenFor(username = "root"))

        mockMvc.delete("/api/users/${actor.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }

        assertNotNull(userRepository.findByUsername("root"))
    }

    @Test
    fun `deleting an unknown account returns not found`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.delete("/api/users/999999") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNotFound() }
        }
    }

    @Test
    fun `viewer cannot delete an account`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val victim = createUser(username = "grace")

        mockMvc.delete("/api/users/${victim.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isForbidden() }
        }

        assertNotNull(userRepository.findByUsername("grace"))
    }

    @Test
    fun `administrator replaces the role of an account`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val target = createUser(username = "grace", role = RoleNames.VIEWER)

        mockMvc.put("/api/users/${target.id}/role") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"role":"orchestrator"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.role") { value(RoleNames.ORCHESTRATOR) }
            jsonPath("$.nodes") { value(contains("agent.chat", "agent.control", "agent.login", "agent.read", "role.read", "user.edit.self", "user.read.self")) }
        }
    }

    @Test
    fun `clearing the role strips every node`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val target = createUser(username = "grace", role = RoleNames.ADMINISTRATOR)

        mockMvc.put("/api/users/${target.id}/role") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"role":null}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.role") { value(null) }
            jsonPath("$.nodes") { isEmpty() }
        }
    }

    @Test
    fun `administrator cannot change their own role`() {
        val actor = createUser(username = "root", role = RoleNames.ADMINISTRATOR)
        val auth = bearer(tokenFor(username = "root"))

        mockMvc.put("/api/users/${actor.id}/role") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"role":"viewer"}"""
        }.andExpect {
            status { isConflict() }
        }

        mockMvc.get("/api/auth/me") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            jsonPath("$.role") { value(RoleNames.ADMINISTRATOR) }
        }
    }

    @Test
    fun `replacing the role rejects an unknown role`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val target = createUser(username = "grace")

        mockMvc.put("/api/users/${target.id}/role") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"role":"wizard"}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `replacing the role on an unknown account returns not found`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.put("/api/users/999999/role") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"role":"viewer"}"""
        }.andExpect {
            status { isNotFound() }
        }
    }

    @Test
    fun `orchestrator cannot replace a role`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val target = createUser(username = "grace")

        mockMvc.put("/api/users/${target.id}/role") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"role":"administrator"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }
}

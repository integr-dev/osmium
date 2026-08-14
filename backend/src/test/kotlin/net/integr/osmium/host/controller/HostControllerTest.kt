package net.integr.osmium.host.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.host.model.Host
import net.integr.osmium.security.RoleNames
import net.integr.osmium.host.service.HostService
import org.hamcrest.Matchers.startsWith
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post

class HostControllerTest : AbstractRestTest() {

    @Autowired private lateinit var hostService: HostService

    @Test
    fun `administrator enrols a host and receives a token once`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.post("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-1"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.host.name") { value("host-eu-1") }
            jsonPath("$.host.reachable") { value(false) }
            jsonPath("$.host.address") { value(null) }
            jsonPath("$.host.agentCount") { value(0) }
            jsonPath("$.token") { value(startsWith("osm_host_")) }
        }
    }

    @Test
    fun `the enrolment token is stored hashed, but still authenticates`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        val body = mockMvc.post("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-1"}"""
        }.andReturn().response.contentAsString

        val token: String = com.jayway.jsonpath.JsonPath.read(body, "$.token")
        val stored = hostRepository.findAll().single()

        // Nothing recoverable is persisted: the stored value is a hash of the secret alone.
        assertNotEquals(token, stored.tokenHash)
        assert(!stored.tokenHash.contains(token.substringAfterLast('_')))

        // The host can still authenticate with the plaintext it was given.
        assertEquals(stored.id, hostService.authenticate(token)?.id)
    }

    @Test
    fun `a tampered or unknown token authenticates nobody`() {
        val host = reachableHost("host-eu-1")

        assertNull(hostService.authenticate("osm_host_${host.id}_wrongsecret"))
        assertNull(hostService.authenticate("osm_host_999999_whatever"))
        assertNull(hostService.authenticate("not-even-a-token"))
        assertNull(hostService.authenticate("osm_host_notanumber_secret"))
    }

    /**
     * A viewer sees the fleet. Enrolling and renaming need `host.write`, rotating the
     * enrolment token `host.token`, and removal `host.delete`.
     */
    @Test
    fun `a viewer can list hosts`() {
        reachableHost("host-eu-1")

        mockMvc.get("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].name") { value("host-eu-1") }
        }
    }

    @Test
    fun `a viewer cannot enrol or remove a host`() {
        val host = reachableHost("host-eu-2")
        val viewer = authAs("ada2", RoleNames.VIEWER)

        mockMvc.post("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, viewer)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-9"}"""
        }.andExpect { status { isForbidden() } }

        mockMvc.delete("/api/hosts/${host.id}") {
            header(HttpHeaders.AUTHORIZATION, viewer)
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `orchestrator can list and enrol hosts`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)

        mockMvc.get("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
        }

        mockMvc.post("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-9"}"""
        }.andExpect {
            status { isCreated() }
        }
    }

    @Test
    fun `orchestrator cannot manage users, which is what separates it from an administrator`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)

        mockMvc.get("/api/users") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `enrolling rejects a duplicate name`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        hostRepository.saveAndFlush(Host(name = "host-eu-1", tokenHash = "x"))

        mockMvc.post("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-1"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `a host with no heartbeat is not reachable`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        hostRepository.saveAndFlush(Host(name = "host-eu-1", tokenHash = "x"))

        mockMvc.get("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].reachable") { value(false) }
        }
    }

    @Test
    fun `a host heartbeating now is reachable`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        reachableHost("host-eu-1")

        mockMvc.get("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].reachable") { value(true) }
        }
    }

    @Test
    fun `a host can be renamed`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val host = reachableHost("host-eu-1")

        mockMvc.patch("/api/hosts/${host.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-renamed"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.name") { value("host-eu-renamed") }
        }
    }

    @Test
    fun `renaming a host rejects a name already enrolled`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        reachableHost("host-eu-1")
        val other = reachableHost("host-eu-2")

        mockMvc.patch("/api/hosts/${other.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-1"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `rotating a token invalidates the old one and keeps the host's agents`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        val enrolled = mockMvc.post("/api/hosts") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-eu-1"}"""
        }.andReturn().response.contentAsString

        val original: String = com.jayway.jsonpath.JsonPath.read(enrolled, "$.token")
        val hostId: Int = com.jayway.jsonpath.JsonPath.read(enrolled, "$.host.id")
        createAgent(label = "Mason_01", host = hostRepository.findById(hostId.toLong()).orElseThrow())

        val rotated = mockMvc.post("/api/hosts/$hostId/rotate-token") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
        }.andReturn().response.contentAsString

        val replacement: String = com.jayway.jsonpath.JsonPath.read(rotated, "$.token")
        assertNotEquals(original, replacement)

        // The point of rotation: the leaked token stops working, the new one takes over.
        assertNull(hostService.authenticate(original))
        assertEquals(hostId.toLong(), hostService.authenticate(replacement)?.id)

        // Rotating must not cost the host its agents - that is what makes it better than re-enrolling.
        assertEquals(1, agentRepository.findAllByHostId(hostId.toLong()).size)
    }

    @Test
    fun `orchestrator can rename and rotate, a viewer cannot`() {
        val host = reachableHost("host-eu-1")

        mockMvc.patch("/api/hosts/${host.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("agent", RoleNames.ORCHESTRATOR))
            contentType = MediaType.APPLICATION_JSON
            content = """{"name":"host-renamed"}"""
        }.andExpect {
            status { isOk() }
        }

        mockMvc.post("/api/hosts/${host.id}/rotate-token") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.VIEWER))
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `removing a host removes its agents`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val host = reachableHost("host-eu-1")
        createAgent(label = "Mason_01", host = host)

        mockMvc.delete("/api/hosts/${host.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNoContent() }
        }

        assertNull(hostRepository.findAll().firstOrNull())
        assert(agentRepository.findAll().isEmpty())
    }

    @Test
    fun `removing an unknown host returns not found`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.delete("/api/hosts/999999") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNotFound() }
        }
    }

    @Test
    fun `listing hosts rejects an unauthenticated request`() {
        mockMvc.get("/api/hosts").andExpect {
            status { isUnauthorized() }
        }
    }
}

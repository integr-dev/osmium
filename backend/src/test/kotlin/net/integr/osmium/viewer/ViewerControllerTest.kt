package net.integr.osmium.viewer

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.post

/**
 * The socket itself cannot be node checked, so this endpoint is the only place `agent.view` is
 * enforced. What it refuses is therefore the whole boundary.
 */
class ViewerControllerTest : AbstractRestTest() {

    @Test
    fun `a viewer may mint a ticket for an agent`() {
        val agent = createAgent("ab-agent", reachableHost())
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.post("/api/agents/${agent.id}/viewer/ticket") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.protocol") { value(ViewerHandshakeAuthenticator.PROTOCOL) }
            jsonPath("$.expiresInSeconds") { value(ViewerTickets.TTL.toSeconds()) }
            // Present and long enough to be a real secret, without asserting the exact encoding.
            jsonPath("$.ticket") { isNotEmpty() }
        }
    }

    @Test
    fun `an account with no role may not`() {
        val agent = createAgent("ab-agent", reachableHost())
        val auth = authAs("nobody")

        mockMvc.post("/api/agents/${agent.id}/viewer/ticket") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `an unauthenticated request is refused`() {
        val agent = createAgent("ab-agent", reachableHost())

        mockMvc.post("/api/agents/${agent.id}/viewer/ticket").andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `an agent that does not exist is a 404, not a ticket that fails later`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.post("/api/agents/999999/viewer/ticket") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNotFound() }
        }
    }

    @Test
    fun `two calls hand out two different tickets`() {
        val agent = createAgent("ab-agent", reachableHost())
        val auth = authAs("ada", RoleNames.VIEWER)

        val first = ticketFrom(agent.id!!, auth)
        val second = ticketFrom(agent.id!!, auth)

        assert(first != second) { "a ticket is single-use, so a second call must mint a new one" }
    }

    private fun ticketFrom(agentId: Long, auth: String): String {
        val body = mockMvc.post("/api/agents/$agentId/viewer/ticket") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andReturn().response.contentAsString

        return checkNotNull(TICKET.find(body)) { "no ticket in $body" }.groupValues[1]
    }

    private companion object {
        val TICKET = """"ticket"\s*:\s*"([^"]+)"""".toRegex()
    }
}

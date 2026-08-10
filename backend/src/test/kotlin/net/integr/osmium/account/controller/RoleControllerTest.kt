package net.integr.osmium.account.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.security.Nodes
import net.integr.osmium.security.RoleNames
import org.hamcrest.Matchers.contains
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.get

class RoleControllerTest : AbstractRestTest() {

    @Test
    fun `administrator lists the three seeded roles with their nodes`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.get("/api/roles") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.length()") { value(3) }
            jsonPath("$[*].name") {
                value(contains(RoleNames.ADMINISTRATOR, RoleNames.ORCHESTRATOR, RoleNames.VIEWER))
            }
            jsonPath("$[?(@.name == 'viewer')].nodes[*]") {
                // A viewer sees the fleet as well as its own account; every node here is a read.
                value(contains(Nodes.FLEET_READ, Nodes.ROLE_READ, Nodes.USER_EDIT_SELF, Nodes.USER_READ_SELF))
            }
            jsonPath("$[?(@.name == 'administrator')].nodes[*]") {
                value(contains(*Nodes.ALL.sorted().toTypedArray()))
            }
        }
    }

    @Test
    fun `each tier inherits every node of the tier below it`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.get("/api/roles") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            // orchestrator holds every viewer node plus full authority over the fleet; the only
            // thing administrator adds on top is user management.
            jsonPath("$[?(@.name == 'orchestrator')].nodes[*]") {
                value(
                    contains(
                        Nodes.FLEET_CHAT,
                        Nodes.FLEET_CONTROL,
                        Nodes.FLEET_LOGIN,
                        Nodes.FLEET_READ,
                        Nodes.ROLE_READ,
                        Nodes.USER_EDIT_SELF,
                        Nodes.USER_READ_SELF,
                    ),
                )
            }
            jsonPath("$[?(@.name == 'administrator')].nodes[*]") {
                value(contains(*Nodes.ALL.sorted().toTypedArray()))
            }
        }
    }

    @Test
    fun `viewer can list roles, so every account can see the ladder`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.get("/api/roles") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.length()") { value(3) }
        }
    }

    @Test
    fun `an account with no role cannot list roles`() {
        val auth = authAs("ghost")

        mockMvc.get("/api/roles") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `listing roles rejects an unauthenticated request`() {
        mockMvc.get("/api/roles").andExpect {
            status { isUnauthorized() }
        }
    }
}

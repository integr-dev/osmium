package net.integr.osmium.agent.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.dto.AgentInventoryResponse
import net.integr.osmium.agent.dto.InventorySlotResponse
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.service.AgentInventoryStore
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.post

/**
 * The inventory endpoints, and the two things they are careful about.
 *
 * **Absent is not empty.** An agent carrying nothing and an agent nobody has heard from look
 * identical if a missing report is answered with an empty list, and only one of those is something
 * an operator should act on.
 *
 * **The slot range is enforced here.** The host refuses an impossible slot too, but a command it
 * refuses is one that was accepted, dispatched and silently dropped - so the browser is told no by
 * the thing it asked, rather than by nothing at all.
 */
class AgentInventoryTest : AbstractRestTest() {

    @Autowired private lateinit var inventoryStore: AgentInventoryStore

    private fun carrying() = AgentInventoryResponse(
        slots = listOf(
            InventorySlotResponse(
                slot = 36,
                name = "diamond_pickaxe",
                displayName = "Diamond Pickaxe",
                count = 1,
                damage = 142,
                maxDamage = 1561,
            ),
        ),
        held = 0,
    )

    @Test
    fun `an agent that has reported an inventory returns it`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_20", host = reachableHost(), state = AgentState.ONLINE)
        inventoryStore.record(agent.id!!, carrying())

        mockMvc.get("/api/agents/${agent.id}/inventory") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.held") { value(0) }
            jsonPath("$.slots[0].slot") { value(36) }
            jsonPath("$.slots[0].name") { value("diamond_pickaxe") }
            jsonPath("$.slots[0].maxDamage") { value(1561) }
        }
    }

    @Test
    fun `an agent that has reported nothing answers with no content rather than an empty grid`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_21", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.get("/api/agents/${agent.id}/inventory") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNoContent() }
        }
    }

    @Test
    fun `reading an inventory needs permission`() {
        val agent = createAgent(label = "Mason_22", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.get("/api/agents/${agent.id}/inventory").andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `moving an item refuses an agent that is not in the game`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // A move is a click in a window that only exists while the agent is playing. Refused here
        // rather than sent, because a host cannot click in a window it does not have open.
        val agent = createAgent(label = "Mason_23", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.post("/api/agents/${agent.id}/inventory/move") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"from":36,"to":9}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `moving an item refuses the crafting output`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_24", host = reachableHost(), state = AgentState.ONLINE)

        // Slot 0 is not a container: putting something into it is not a move any server can take.
        mockMvc.post("/api/agents/${agent.id}/inventory/move") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"from":36,"to":0}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `moving an item refuses a slot outside the window`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_25", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/inventory/move") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"from":36,"to":46}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `moving an item reaches delivery for an agent whose host is not there`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // 503 rather than 409: the request is a legitimate one about an agent in the game, and what
        // stops it is that nothing is listening on the other side.
        val agent = createAgent(label = "Mason_26", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/inventory/move") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"from":36,"to":9}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

    @Test
    fun `dropping refuses a count of nothing`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // Zero is not "the whole stack" - that is what leaving it out means - and it is not a drop
        // either. Refused rather than treated as one or the other.
        val agent = createAgent(label = "Mason_27", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/inventory/drop") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"slot":36,"count":0}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `holding refuses a square outside the hotbar`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // Narrower than a move: the armour, the backpack and the off hand are all places an item
        // can go, and none of them can be the square in hand.
        val agent = createAgent(label = "Mason_29", host = reachableHost(), state = AgentState.ONLINE)

        for (slot in listOf(9, 35, 45)) {
            mockMvc.post("/api/agents/${agent.id}/inventory/hold") {
                header(HttpHeaders.AUTHORIZATION, auth)
                contentType = MediaType.APPLICATION_JSON
                content = """{"slot":$slot}"""
            }.andExpect {
                status { isBadRequest() }
            }
        }
    }

    @Test
    fun `holding refuses an agent that is not in the game`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_30", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.post("/api/agents/${agent.id}/inventory/hold") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"slot":40}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `an inventory survives being read over and over`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // The regression this exists for: it used to age out on a clock, so an operator reloading
        // the page a minute later was told the agent had reported nothing. Nothing refreshes an
        // inventory that has not changed, so there was never anything to keep it alive.
        val agent = createAgent(label = "Mason_31", host = reachableHost(), state = AgentState.ONLINE)
        inventoryStore.record(agent.id!!, carrying())

        repeat(3) {
            mockMvc.get("/api/agents/${agent.id}/inventory") {
                header(HttpHeaders.AUTHORIZATION, auth)
            }.andExpect {
                status { isOk() }
                jsonPath("$.slots[0].slot") { value(36) }
            }
        }
    }

    @Test
    fun `moving an item needs more than permission to look`() {
        val agent = createAgent(label = "Mason_28", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/inventory/move") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada2", RoleNames.VIEWER))
            contentType = MediaType.APPLICATION_JSON
            content = """{"from":36,"to":9}"""
        }.andExpect {
            status { isForbidden() }
        }
    }
}

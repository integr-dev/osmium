package net.integr.osmium.agent.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.chat.service.ChatRateLimiter
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post
import kotlin.test.assertEquals

class AgentControllerTest : AbstractRestTest() {

    @Autowired private lateinit var chatRateLimiter: ChatRateLimiter
    @Autowired private lateinit var auditEntryRepository: AuditEntryRepository

    @Test
    fun `orchestrator creates an agent, which starts unlinked`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val host = reachableHost()

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.label") { value("Mason_01") }
            jsonPath("$.state") { value(AgentState.UNLINKED.name) }
            jsonPath("$.hostName") { value(host.name) }
            jsonPath("$.mcUsername") { value(null) }
        }
    }

    @Test
    fun `the server address is normalised, so one server does not become two`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val host = reachableHost()

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"  MC.Example.com  "}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.serverAddress") { value("mc.example.com:25565") }
        }

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_02","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.serverAddress") { value("mc.example.com:25565") }
        }

        // Both agents must land on the same grouping key, or they get separate chat listeners.
        assert(agentRepository.findAll().map { it.serverAddress }.distinct().size == 1)
    }

    @Test
    fun `viewer cannot create an agent`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val host = reachableHost()

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `creating an agent rejects a duplicate label`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val host = reachableHost()
        createAgent(label = "Mason_01", host = host)

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `creating an agent rejects an unknown host`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":999999,"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `an agent on an unreachable host reports its stored state, and online becomes stale`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val cold = unreachableHost()
        createAgent(label = "Mason_01", host = cold, state = AgentState.ONLINE)
        createAgent(label = "Mason_02", host = cold, state = AgentState.LINKED)

        mockMvc.get("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            // ONLINE is not trustworthy without a live host; LINKED is unaffected.
            jsonPath("$[?(@.label == 'Mason_01')].state") { value(AgentState.STALE.name) }
            jsonPath("$[?(@.label == 'Mason_02')].state") { value(AgentState.LINKED.name) }
        }
    }

    @Test
    fun `commands to an agent on an unreachable host fail fast rather than queueing`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val agent = createAgent(label = "Mason_01", host = unreachableHost(), state = AgentState.LINKED)

        mockMvc.post("/api/agents/${agent.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isServiceUnavailable() }
        }

        mockMvc.post("/api/agents/${agent.id}/setup") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"method":"device_code"}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }

        // The failed command must not have advanced the state.
        assert(agentRepository.findById(agent.id!!).orElseThrow().state == AgentState.LINKED)
    }

    @Test
    fun `state is validated before delivery is attempted`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        // Reachable, so a 503 cannot mask the state check - but there is still no host behind it.
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.UNLINKED)

        mockMvc.post("/api/agents/${agent.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }

        mockMvc.post("/api/agents/${agent.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `setup is refused while another setup is already running`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.SETUP_PENDING)

        mockMvc.post("/api/agents/${agent.id}/setup") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"method":"device_code"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `orchestrator has full authority over agents`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.ONLINE)

        // 503 rather than 403: authorization passed, there is simply no host to deliver to.
        mockMvc.post("/api/agents/${agent.id}/chat") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"hello"}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }

        mockMvc.post("/api/agents/${agent.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

    @Test
    fun `viewer cannot speak as an agent`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/chat") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"hello"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    /**
     * 429, not 403 or 409: the request was valid and the operator was allowed to make it. It is
     * refused on the *agent's* behalf, because chat spam is what gets a Minecraft account banned.
     */
    @Test
    fun `chat is refused once the agent has spoken too often`() {
        val auth = authAs("chatty", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.ONLINE)
        val id = checkNotNull(agent.id)

        // Drained directly rather than over 30 requests: this is about the endpoint honouring the
        // limiter, and ChatRateLimiterTest already covers the counting.
        repeat(30) { chatRateLimiter.check(id, agent.label) }

        mockMvc.post("/api/agents/$id/chat") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"hello"}"""
        }.andExpect {
            status { isTooManyRequests() }
        }

        // Same rule as an undeliverable command: nothing was said, so there is nothing to record.
        assertEquals(0, auditEntryRepository.count())

        chatRateLimiter.forget(id)
    }

    /**
     * The budget lives outside the transaction, so a rolled-back command would otherwise keep what
     * it spent — and an operator retrying a dead host would talk themselves out of chatting.
     */
    @Test
    fun `an undeliverable message does not count against the limit`() {
        val auth = authAs("hopeful", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_02", host = unreachableHost(), state = AgentState.ONLINE)
        val id = checkNotNull(agent.id)

        repeat(3) {
            mockMvc.post("/api/agents/$id/chat") {
                header(HttpHeaders.AUTHORIZATION, auth)
                contentType = MediaType.APPLICATION_JSON
                content = """{"message":"anyone there"}"""
            }.andExpect { status { isServiceUnavailable() } }
        }

        // All three were refunded, so the full allowance is still there.
        repeat(30) { chatRateLimiter.check(id, agent.label) }

        chatRateLimiter.forget(id)
    }

    @Test
    fun `chat rejects a blank message`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.post("/api/agents/${agent.id}/chat") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"   "}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `commands on an unknown agent return not found`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.post("/api/agents/999999/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNotFound() }
        }

        mockMvc.get("/api/agents/999999") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNotFound() }
        }
    }

    @Test
    fun `an agent can be renamed and moved to another server`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.patch("/api/agents/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_09","serverAddress":"Other.Example.com"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.label") { value("Mason_09") }
            jsonPath("$.serverAddress") { value("other.example.com:25565") }
            // The account is the same account wherever it joins, so credentials are untouched.
            jsonPath("$.state") { value(AgentState.LINKED.name) }
        }
    }

    @Test
    fun `an agent cannot be moved to another server while it is online`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.patch("/api/agents/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"other.example.com:25565"}"""
        }.andExpect {
            status { isConflict() }
        }

        // Renaming is unaffected: the label is only a display name.
        mockMvc.patch("/api/agents/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_09"}"""
        }.andExpect {
            status { isOk() }
        }
    }

    @Test
    fun `renaming an agent rejects a label already in use`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val host = reachableHost()
        createAgent(label = "Mason_01", host = host)
        val other = createAgent(label = "Mason_02", host = host)

        mockMvc.patch("/api/agents/${other.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `viewer cannot edit an agent`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val target = createAgent(label = "Mason_01", host = reachableHost())

        mockMvc.patch("/api/agents/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"pwned"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `orchestrator deletes an agent`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost())

        mockMvc.delete("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNoContent() }
        }

        assert(agentRepository.findAll().isEmpty())
    }

    /**
     * A viewer watches the fleet but cannot touch it. `fleet.read` gates listing and the live
     * streams only; every way to change an agent is a separate node, which is what makes a
     * read-only tier possible without a second set of routes.
     */
    @Test
    fun `a viewer can list agents`() {
        createAgent("Mason_01", reachableHost())

        mockMvc.get("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
            jsonPath("$[0].label") { value("Mason_01") }
        }
    }

    @Test
    fun `a viewer can read one agent`() {
        val agent = createAgent("Mason_02", reachableHost())

        mockMvc.get("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada2", RoleNames.VIEWER))
        }.andExpect {
            status { isOk() }
        }
    }

    /** The other half of the tier: reading is allowed, acting is not. */
    @Test
    fun `a viewer cannot connect or disconnect an agent`() {
        val agent = createAgent("Mason_03", reachableHost(), state = AgentState.LINKED)
        val viewer = authAs("ada3", RoleNames.VIEWER)

        mockMvc.post("/api/agents/${agent.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, viewer)
        }.andExpect { status { isForbidden() } }

        mockMvc.post("/api/agents/${agent.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, viewer)
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `a viewer cannot set an agent up`() {
        val agent = createAgent("Mason_04", reachableHost())

        mockMvc.post("/api/agents/${agent.id}/setup") {
            header(HttpHeaders.AUTHORIZATION, authAs("ada4", RoleNames.VIEWER))
            contentType = MediaType.APPLICATION_JSON
            content = """{"method":"method_a"}"""
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `listing agents rejects an unauthenticated request`() {
        mockMvc.get("/api/agents").andExpect {
            status { isUnauthorized() }
        }
    }
}

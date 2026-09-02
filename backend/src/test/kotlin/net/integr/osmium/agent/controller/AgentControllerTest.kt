package net.integr.osmium.agent.controller
import com.jayway.jsonpath.JsonPath

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.audit.repository.AuditEntryRepository
import net.integr.osmium.agent.service.AgentService
import net.integr.osmium.chat.service.ChatRateLimiter
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.put
import java.time.Duration
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AgentControllerTest : AbstractRestTest() {

    @Autowired private lateinit var chatRateLimiter: ChatRateLimiter
    @Autowired private lateinit var auditEntryRepository: AuditEntryRepository
    @Autowired private lateinit var agentService: AgentService

    @Test
    fun `orchestrator creates an agent, which starts unlinked`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val host = reachableHost()

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com"}"""
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
            jsonPath("$.serverAddress") { value("mc.example.com") }
        }

        mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_02","hostId":${host.id},"serverAddress":"mc.example.com"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.serverAddress") { value("mc.example.com") }
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
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com"}"""
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
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com"}"""
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
            content = """{"label":"Mason_01","hostId":999999,"serverAddress":"mc.example.com"}"""
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

    /** Same shape as the setup guard below, and the same reason: one command in flight at a time. */
    @Test
    fun `connect is refused while a connect is already running`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.CONNECTING)

        mockMvc.post("/api/agents/${agent.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }
    }

    /**
     * The state has to be able to end on its own, or it is worse than what it replaced.
     *
     * Before CONNECTING existed, a connect nobody answered left the agent at LINKED, where the
     * operator could simply press the button again. A pending state that never clears refuses the
     * retry *and* goes on claiming something is happening.
     */
    @Test
    fun `a connect the host never answers stops claiming to be connecting`() {
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.CONNECTING)
        agent.connectingSince = Instant.now().minus(Duration.ofHours(1))
        agentRepository.saveAndFlush(agent)

        agentService.abandonStalledConnects()

        val expired = agentRepository.findById(agent.id!!).orElseThrow()
        // LINKED, not CONNECT_FAILED: nothing refused this agent, the host simply went quiet, and a
        // red badge would blame a Minecraft server that was never asked.
        assertEquals(AgentState.LINKED, expired.state)
        assertNull(expired.connectingSince)
    }

    /** The window is generous on purpose, and a join still inside it is not a stall. */
    @Test
    fun `a connect still within its window is left alone`() {
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.CONNECTING)
        agent.connectingSince = Instant.now()
        agentRepository.saveAndFlush(agent)

        agentService.abandonStalledConnects()

        assertEquals(AgentState.CONNECTING, agentRepository.findById(agent.id!!).orElseThrow().state)
    }

    /**
     * SETUP_PENDING has no timeout and should not have one — the backend cannot see how far along a
     * login is. So the way out is the operator saying it is not coming, and the point of the test is
     * that afterwards the agent can be set up again rather than being stuck asking for a setup that
     * is refused because a setup is in progress.
     */
    @Test
    fun `an operator can stop waiting on a setup that was never completed`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.SETUP_PENDING)

        mockMvc.delete("/api/agents/${agent.id}/setup") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.state") { value(AgentState.UNLINKED.name) }
        }

        assertEquals(AgentState.UNLINKED, agentRepository.findById(agent.id!!).orElseThrow().state)
    }

    /** Nothing to stop waiting on. A 409 rather than a silent success, which would imply it did. */
    @Test
    fun `stopping a setup that is not running is refused`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.delete("/api/agents/${agent.id}/setup") {
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
    fun `an agent can be renamed`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.patch("/api/agents/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_09"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.label") { value("Mason_09") }
            jsonPath("$.state") { value(AgentState.LINKED.name) }
        }
    }

    /** Where an agent plays is its own operation now, not a field on the edit. */
    @Test
    fun `an agent is pointed at a server through its own endpoint`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.put("/api/agents/${target.id}/server") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"Other.Example.com"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.serverAddress") { value("other.example.com") }
            // The account is the same account wherever it joins, so credentials are untouched.
            jsonPath("$.state") { value(AgentState.LINKED.name) }
        }
    }

    /**
     * The default port is dropped, any other port is kept.
     *
     * The address is a grouping key compared as a string, so the two spellings of one server still
     * have to collapse to one - but they collapse to the bare one now. A host cannot tell an
     * operator who typed a bare hostname from one who chose port 25565, and the bare case is exactly
     * where the SRV record is supposed to decide where to connect.
     */
    @Test
    fun `the default port is not written onto a server address`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.put("/api/agents/${target.id}/server") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.serverAddress") { value("mc.example.com") }
        }

        // Naming a different port is how an operator says "this exact socket", so it survives.
        mockMvc.put("/api/agents/${target.id}/server") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"mc.example.com:41945"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.serverAddress") { value("mc.example.com:41945") }
        }
    }

    /**
     * Configuration is a stated preference rather than an action, so it is stored whether or not the
     * host is there to take it — the alternative loses an operator's work over a machine they cannot
     * see and did not switch off. It reaches the host on its next connection.
     */
    @Test
    fun `settings are kept for an agent whose host is unreachable`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.put("/api/agents/${target.id}/settings") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"values":{"chat.sender":"^<([A-Za-z0-9_]{1,16})> "}}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.settings['chat.sender']") { value("^<([A-Za-z0-9_]{1,16})> ") }
        }
    }

    /** The whole set, not a patch: a key left out has been cleared, which is the only reading under
     * which a setting can be turned back off. */
    @Test
    fun `settings replace what was there rather than merging into it`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_02", host = reachableHost(), state = AgentState.LINKED)

        fun configure(body: String) = mockMvc.put("/api/agents/${target.id}/settings") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = body
        }

        configure("""{"values":{"chat.sender":"a","other":"b"}}""").andExpect { status { isOk() } }

        configure("""{"values":{"chat.sender":"c"}}""").andExpect {
            status { isOk() }
            jsonPath("$.settings['chat.sender']") { value("c") }
            jsonPath("$.settings.other") { doesNotExist() }
        }

        // And cleared entirely, which an absent map means as surely as an empty one.
        configure("""{"values":{}}""").andExpect {
            status { isOk() }
            jsonPath("$.settings['chat.sender']") { doesNotExist() }
        }
    }

    /**
     * The state the old shape could not express: set up, and deliberately playing nowhere. It used
     * to be faked by pointing an agent at a server it was not connected to, which then showed up
     * under Active servers with nobody on it.
     */
    @Test
    fun `an agent can be assigned to no server at all`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.put("/api/agents/${target.id}/server") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":null}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.serverAddress") { doesNotExist() }
        }

        // And it cannot connect from there, because there is nowhere to connect to.
        mockMvc.post("/api/agents/${target.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect { status { isConflict() } }
    }

    @Test
    fun `an agent may be created without a server and given one later`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val host = reachableHost()

        // Requiring one at creation made the operator decide where an agent would play before
        // knowing whether its credential even worked.
        val created = mockMvc.post("/api/agents") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_10","hostId":${host.id}}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.serverAddress") { doesNotExist() }
        }.andReturn().response.contentAsString

        val id = JsonPath.read<Int>(created, "$.id")
        mockMvc.put("/api/agents/$id/server") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"mc.example.com"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.serverAddress") { value("mc.example.com") }
        }
    }

    @Test
    fun `an agent cannot be moved to another server while it is online`() {
        val auth = authAs("agent", RoleNames.ORCHESTRATOR)
        val target = createAgent(label = "Mason_01", host = reachableHost(), state = AgentState.ONLINE)

        mockMvc.put("/api/agents/${target.id}/server") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"other.example.com"}"""
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
    fun `administrator deletes an agent`() {
        val auth = authAs("agent", RoleNames.ADMINISTRATOR)
        val agent = createAgent(label = "Mason_01", host = reachableHost())

        mockMvc.delete("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNoContent() }
        }

        assert(agentRepository.findAll().isEmpty())
    }

    /**
     * The point of splitting the old single control node: the tier that runs the fleet all day is
     * not the tier trusted to destroy part of it. An orchestrator connects, renames and sets up
     * agents, and is refused the one action that takes an agent and its history with it.
     */
    @Test
    fun `an orchestrator cannot delete an agent`() {
        val agent = createAgent(label = "Mason_88", host = reachableHost())

        mockMvc.delete("/api/agents/${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("runner", RoleNames.ORCHESTRATOR))
        }.andExpect {
            status { isForbidden() }
        }

        assert(agentRepository.findAll().isNotEmpty())
    }

    /**
     * A viewer watches the fleet but cannot touch it. `agent.read` gates listing and the live
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
            content = """{"method":"device_code"}"""
        }.andExpect { status { isForbidden() } }
    }

    @Test
    fun `listing agents rejects an unauthenticated request`() {
        mockMvc.get("/api/agents").andExpect {
            status { isUnauthorized() }
        }
    }

    @Test
    fun `disconnect reaches delivery for an agent still on its way in`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_09", host = reachableHost(), state = AgentState.CONNECTING)
        agent.wanted = true
        agentRepository.saveAndFlush(agent)

        // 503, not 409: the state check now admits CONNECTING, and what stops it here is that no
        // host is behind this one. Before, an attempt in flight could not be cancelled at all.
        mockMvc.post("/api/agents/${agent.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

    @Test
    fun `disconnect stops an agent that is waiting to try again`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // The banned-agent case: not online, not connecting, and due to dial again shortly.
        val agent = createAgent(label = "Mason_10", host = reachableHost(), state = AgentState.CONNECT_FAILED)
        agent.wanted = true
        agent.rejoinAttempts = 3
        agent.rejoinAt = Instant.now().plusSeconds(60)
        agentRepository.saveAndFlush(agent)

        mockMvc.post("/api/agents/${agent.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            jsonPath("$.rejoining") { value(false) }
        }

        val stored = agentRepository.findById(agent.id!!).orElseThrow()
        assertFalse(stored.wanted)
        assertEquals(0, stored.rejoinAttempts)
        assertNull(stored.rejoinAt)
    }

    @Test
    fun `disconnect refuses an agent that is neither connected nor trying`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        val agent = createAgent(label = "Mason_11", host = reachableHost(), state = AgentState.LINKED)

        mockMvc.post("/api/agents/${agent.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `an agent waiting to rejoin can be stopped even though its host is unreachable`() {
        val auth = authAs("ada", RoleNames.ORCHESTRATOR)
        // Nothing is dispatched in this case, so there is nothing an unreachable host can refuse -
        // and stranding the intent is the one outcome an operator cannot work around.
        val agent = createAgent(label = "Mason_12", host = unreachableHost(), state = AgentState.CONNECT_FAILED)
        agent.wanted = true
        agentRepository.saveAndFlush(agent)

        mockMvc.post("/api/agents/${agent.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
        }

        assertFalse(agentRepository.findById(agent.id!!).orElseThrow().wanted)
    }

}

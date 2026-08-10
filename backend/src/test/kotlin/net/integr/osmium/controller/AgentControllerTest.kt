package net.integr.osmium.controller

import net.integr.osmium.AbstractRestTest
import net.integr.osmium.model.BotState
import net.integr.osmium.security.RoleNames
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.delete
import org.springframework.test.web.servlet.get
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.post

class BotControllerTest : AbstractRestTest() {

    @Test
    fun `orchestrator creates a bot, which starts unlinked`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val host = reachableHost()

        mockMvc.post("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.label") { value("Mason_01") }
            jsonPath("$.state") { value(BotState.UNLINKED.name) }
            jsonPath("$.hostName") { value(host.name) }
            jsonPath("$.mcUsername") { value(null) }
        }
    }

    @Test
    fun `the server address is normalised, so one server does not become two`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val host = reachableHost()

        mockMvc.post("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"  MC.Example.com  "}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.serverAddress") { value("mc.example.com:25565") }
        }

        mockMvc.post("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_02","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isCreated() }
            jsonPath("$.serverAddress") { value("mc.example.com:25565") }
        }

        // Both bots must land on the same grouping key, or they get separate chat listeners.
        assert(botRepository.findAll().map { it.serverAddress }.distinct().size == 1)
    }

    @Test
    fun `viewer cannot create a bot`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val host = reachableHost()

        mockMvc.post("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `creating a bot rejects a duplicate label`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val host = reachableHost()
        createBot(label = "Mason_01", host = host)

        mockMvc.post("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":${host.id},"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `creating a bot rejects an unknown host`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)

        mockMvc.post("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01","hostId":999999,"serverAddress":"mc.example.com:25565"}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `a bot on an unreachable host reports its stored state, and online becomes stale`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val cold = unreachableHost()
        createBot(label = "Mason_01", host = cold, state = BotState.ONLINE)
        createBot(label = "Mason_02", host = cold, state = BotState.LINKED)

        mockMvc.get("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isOk() }
            // ONLINE is not trustworthy without a live agent; LINKED is unaffected.
            jsonPath("$[?(@.label == 'Mason_01')].state") { value(BotState.STALE.name) }
            jsonPath("$[?(@.label == 'Mason_02')].state") { value(BotState.LINKED.name) }
        }
    }

    @Test
    fun `commands to a bot on an unreachable host fail fast rather than queueing`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val bot = createBot(label = "Mason_01", host = unreachableHost(), state = BotState.LINKED)

        mockMvc.post("/api/bots/${bot.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isServiceUnavailable() }
        }

        mockMvc.post("/api/bots/${bot.id}/setup") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"method":"device_code"}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }

        // The failed command must not have advanced the state.
        assert(botRepository.findById(bot.id!!).orElseThrow().state == BotState.LINKED)
    }

    @Test
    fun `state is validated before delivery is attempted`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        // Reachable, so a 503 cannot mask the state check - but there is still no agent behind it.
        val bot = createBot(label = "Mason_01", host = reachableHost(), state = BotState.UNLINKED)

        mockMvc.post("/api/bots/${bot.id}/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }

        mockMvc.post("/api/bots/${bot.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `setup is refused while another setup is already running`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val bot = createBot(label = "Mason_01", host = reachableHost(), state = BotState.SETUP_PENDING)

        mockMvc.post("/api/bots/${bot.id}/setup") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"method":"device_code"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `orchestrator has full authority over bots`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val bot = createBot(label = "Mason_01", host = reachableHost(), state = BotState.ONLINE)

        // 503 rather than 403: authorization passed, there is simply no agent to deliver to.
        mockMvc.post("/api/bots/${bot.id}/chat") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"hello"}"""
        }.andExpect {
            status { isServiceUnavailable() }
        }

        mockMvc.post("/api/bots/${bot.id}/disconnect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isServiceUnavailable() }
        }
    }

    @Test
    fun `viewer cannot speak as a bot`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val bot = createBot(label = "Mason_01", host = reachableHost(), state = BotState.ONLINE)

        mockMvc.post("/api/bots/${bot.id}/chat") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"hello"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `chat rejects a blank message`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)
        val bot = createBot(label = "Mason_01", host = reachableHost(), state = BotState.ONLINE)

        mockMvc.post("/api/bots/${bot.id}/chat") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"message":"   "}"""
        }.andExpect {
            status { isBadRequest() }
        }
    }

    @Test
    fun `commands on an unknown bot return not found`() {
        val auth = authAs("root", RoleNames.ADMINISTRATOR)

        mockMvc.post("/api/bots/999999/connect") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNotFound() }
        }

        mockMvc.get("/api/bots/999999") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNotFound() }
        }
    }

    @Test
    fun `a bot can be renamed and moved to another server`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val target = createBot(label = "Mason_01", host = reachableHost(), state = BotState.LINKED)

        mockMvc.patch("/api/bots/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_09","serverAddress":"Other.Example.com"}"""
        }.andExpect {
            status { isOk() }
            jsonPath("$.label") { value("Mason_09") }
            jsonPath("$.serverAddress") { value("other.example.com:25565") }
            // The account is the same account wherever it joins, so credentials are untouched.
            jsonPath("$.state") { value(BotState.LINKED.name) }
        }
    }

    @Test
    fun `a bot cannot be moved to another server while it is online`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val target = createBot(label = "Mason_01", host = reachableHost(), state = BotState.ONLINE)

        mockMvc.patch("/api/bots/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"serverAddress":"other.example.com:25565"}"""
        }.andExpect {
            status { isConflict() }
        }

        // Renaming is unaffected: the label is only a display name.
        mockMvc.patch("/api/bots/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_09"}"""
        }.andExpect {
            status { isOk() }
        }
    }

    @Test
    fun `renaming a bot rejects a label already in use`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val host = reachableHost()
        createBot(label = "Mason_01", host = host)
        val other = createBot(label = "Mason_02", host = host)

        mockMvc.patch("/api/bots/${other.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"Mason_01"}"""
        }.andExpect {
            status { isConflict() }
        }
    }

    @Test
    fun `viewer cannot edit a bot`() {
        val auth = authAs("ada", RoleNames.VIEWER)
        val target = createBot(label = "Mason_01", host = reachableHost())

        mockMvc.patch("/api/bots/${target.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
            contentType = MediaType.APPLICATION_JSON
            content = """{"label":"pwned"}"""
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `orchestrator deletes a bot`() {
        val auth = authAs("bot", RoleNames.ORCHESTRATOR)
        val bot = createBot(label = "Mason_01", host = reachableHost())

        mockMvc.delete("/api/bots/${bot.id}") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isNoContent() }
        }

        assert(botRepository.findAll().isEmpty())
    }

    @Test
    fun `listing bots requires agent read`() {
        val auth = authAs("ada", RoleNames.VIEWER)

        mockMvc.get("/api/bots") {
            header(HttpHeaders.AUTHORIZATION, auth)
        }.andExpect {
            status { isForbidden() }
        }
    }

    @Test
    fun `listing bots rejects an unauthenticated request`() {
        mockMvc.get("/api/bots").andExpect {
            status { isUnauthorized() }
        }
    }
}

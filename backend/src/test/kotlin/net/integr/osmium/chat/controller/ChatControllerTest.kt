package net.integr.osmium.chat.controller

import com.jayway.jsonpath.JsonPath
import net.integr.osmium.AbstractRestTest
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.chat.model.ChatMessage
import net.integr.osmium.chat.model.ChatScope
import net.integr.osmium.chat.repository.ChatMessageRepository
import net.integr.osmium.chat.service.ChatService
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostReportService
import net.integr.osmium.hostlink.MessageKind
import org.hamcrest.Matchers.contains
import org.hamcrest.Matchers.containsInAnyOrder
import org.hamcrest.Matchers.hasSize
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.get
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatControllerTest : AbstractRestTest() {

    @Autowired private lateinit var chatMessageRepository: ChatMessageRepository
    @Autowired private lateinit var chatService: ChatService
    @Autowired private lateinit var hostReports: HostReportService
    @Autowired private lateinit var objectMapper: ObjectMapper

    private fun line(
        agent: Agent,
        scope: ChatScope,
        text: String,
        from: String = "Notch",
        at: Instant = Instant.now(),
    ) = chatMessageRepository.saveAndFlush(
        ChatMessage(
            at = at,
            agentId = agent.id,
            agentLabel = agent.label,
            // Every agent these tests build is assigned to one, and an unassigned agent could not
            // have said anything in the first place.
            serverAddress = checkNotNull(agent.serverAddress),
            scope = scope,
            sender = from,
            text = text,
        ),
    )

    // ---- the two feeds -------------------------------------------------------------------------

    /**
     * The split that the whole design turns on: a server's global chat is identical for every agent
     * on it, so putting it on the agent page would bury the lines that are actually about the agent.
     */
    @Test
    fun `an agent's feed excludes the server's global chat`() {
        val agent = createAgent("Mason_01", reachableHost())
        line(agent, ChatScope.GLOBAL, "anyone got deepslate")
        line(agent, ChatScope.DIRECT, "hey Mason_01")
        line(agent, ChatScope.OUTBOUND, "on my way")

        mockMvc.get("/api/chat?agentId=${agent.id}") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "viewer"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[*].text") { value(contains("on my way", "hey Mason_01")) }
        }
    }

    /**
     * Everything that happened on the server, not the global channel alone: a whisper to one agent
     * is still something that happened there. The one thing it must not include is another server.
     */
    @Test
    fun `a server's feed is everything said there, whichever agent heard it`() {
        val host = reachableHost()
        val listener = createAgent("Mason_01", host, server = "mc.example.com:25565")
        val second = createAgent("Mason_02", host, server = "mc.example.com:25565")
        val elsewhere = createAgent("Mason_03", host, server = "other.example.com:25565")
        line(listener, ChatScope.GLOBAL, "seen on mc")
        line(listener, ChatScope.DIRECT, "whispered to the listener")
        line(second, ChatScope.OUTBOUND, "said by the second agent")
        line(second, ChatScope.LOCAL, "muttered nearby")
        line(elsewhere, ChatScope.GLOBAL, "seen on other")

        mockMvc.get("/api/chat?server=mc.example.com:25565") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "viewer"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[*].text") {
                value(
                    containsInAnyOrder(
                        "seen on mc",
                        "whispered to the listener",
                        "said by the second agent",
                        "muttered nearby",
                    ),
                )
            }
        }
    }

    /** The feed outlives the agent that forwarded it, which is why the label is copied, not joined. */
    @Test
    fun `a server's feed survives the agent that forwarded it`() {
        val agent = createAgent("Mason_01", reachableHost())
        line(agent, ChatScope.GLOBAL, "still here")
        agentRepository.deleteById(checkNotNull(agent.id))
        agentRepository.flush()

        mockMvc.get("/api/chat?server=mc.example.com:25565") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "viewer"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items[0].text") { value("still here") }
            jsonPath("$.items[0].agentLabel") { value("Mason_01") }
        }
    }

    @Test
    fun `asking for neither or both filters is rejected`() {
        mockMvc.get("/api/chat") {
            header(HttpHeaders.AUTHORIZATION, authAs("neither", "viewer"))
        }.andExpect { status { isBadRequest() } }

        mockMvc.get("/api/chat?agentId=1&server=mc.example.com:25565") {
            header(HttpHeaders.AUTHORIZATION, authAs("both", "viewer"))
        }.andExpect { status { isBadRequest() } }
    }

    // ---- paging --------------------------------------------------------------------------------

    @Test
    fun `the cursor walks a busy feed to the end`() {
        val agent = createAgent("Mason_01", reachableHost())
        val now = Instant.now()
        repeat(5) { index ->
            line(agent, ChatScope.GLOBAL, "line $index", at = now.minusSeconds(index.toLong()))
        }

        val seen = mutableListOf<String>()
        var cursor: String? = ""
        var pages = 0

        while (cursor != null) {
            val suffix = if (cursor.isEmpty()) "" else "&cursor=$cursor"
            val body = mockMvc.get("/api/chat?server=mc.example.com:25565&limit=2$suffix") {
                header(HttpHeaders.AUTHORIZATION, authAs("walker$pages", "viewer"))
            }.andExpect { status { isOk() } }.andReturn().response.contentAsString

            seen += JsonPath.read<List<String>>(body, "$.items[*].text")
            cursor = JsonPath.read<String?>(body, "$.nextCursor")
            pages++
        }

        assertEquals(listOf("line 0", "line 1", "line 2", "line 3", "line 4"), seen)
        assertEquals(3, pages)
    }

    @Test
    fun `a malformed cursor is rejected`() {
        mockMvc.get("/api/chat?agentId=1&cursor=nonsense") {
            header(HttpHeaders.AUTHORIZATION, authAs("confused", "viewer"))
        }.andExpect { status { isBadRequest() } }
    }

    // ---- authorization -------------------------------------------------------------------------

    @Test
    fun `an anonymous request is rejected`() {
        mockMvc.get("/api/chat?agentId=1").andExpect { status { isUnauthorized() } }
    }

    // ---- ingest --------------------------------------------------------------------------------

    private fun event(agent: Agent, payload: String) = HostEnvelope(
        kind = MessageKind.EVENT,
        type = EventType.CHAT,
        agentId = agent.id,
        payload = objectMapper.readTree(payload),
    )

    @Test
    fun `a host reporting chat has it stored against the agent's server`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(
            checkNotNull(host.id),
            event(agent, """{"scope":"global","from":"Notch","text":"that cathedral is huge"}"""),
        )

        val stored = chatMessageRepository.findAll().single()
        assertEquals(ChatScope.GLOBAL, stored.scope)
        assertEquals("Notch", stored.sender)
        assertEquals("mc.example.com:25565", stored.serverAddress)
        assertEquals("Mason_01", stored.agentLabel)
    }

    /** Filing chat into the wrong feed is worse than losing it, so an unknown scope is dropped. */
    @Test
    fun `a scope the backend does not know is dropped rather than guessed at`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(
            checkNotNull(host.id),
            event(agent, """{"scope":"telepathy","from":"Notch","text":"…"}"""),
        )

        assertEquals(0, chatMessageRepository.count())
    }

    @Test
    fun `an empty message is dropped`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(checkNotNull(host.id), event(agent, """{"scope":"local","text":"  "}"""))

        assertEquals(0, chatMessageRepository.count())
    }

    /** The same ownership check every other reported event gets: a host may not speak for an agent. */
    @Test
    fun `a host cannot report chat for an agent it does not own`() {
        val agent = createAgent("Mason_01", reachableHost("host-a"))
        val intruder = reachableHost("host-b")

        hostReports.onMessage(
            checkNotNull(intruder.id),
            event(agent, """{"scope":"global","from":"Notch","text":"not yours"}"""),
        )

        assertEquals(0, chatMessageRepository.count())
    }

    /** Outbound is recorded when the host echoes what was actually said, not on dispatch. */
    @Test
    fun `an outbound line is attributed to the agent when no sender is given`() {
        val host = reachableHost()
        val agent = createAgent("Mason_01", host)

        hostReports.onMessage(
            checkNotNull(host.id),
            event(agent, """{"scope":"outbound","text":"hello world"}"""),
        )

        assertEquals("Mason_01", chatMessageRepository.findAll().single().sender)
    }

    @Test
    fun `an over-long message is truncated rather than rejected`() {
        val agent = createAgent("Mason_01", reachableHost())

        val saved = chatService.record(
            agent = agent,
            scope = ChatScope.GLOBAL,
            from = "Notch",
            text = "x".repeat(ChatMessage.TEXT_MAX + 50),
        )

        assertEquals(ChatMessage.TEXT_MAX, saved.text.length)
    }

    // ---- retention -----------------------------------------------------------------------------

    /** Not transactional: the purge is a bulk delete, so a rolled-back transaction would not see it. */
    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    fun `the purge drops chat past its retention and keeps the rest`() {
        chatMessageRepository.deleteAll()
        val host = hostRepository.saveAndFlush(net.integr.osmium.host.model.Host(name = "purge-host", tokenHash = "h"))
        val agent = createAgent("Mason_purge", host)

        val stale = line(agent, ChatScope.GLOBAL, "old", at = Instant.now().minus(4, ChronoUnit.DAYS))
        val fresh = line(agent, ChatScope.GLOBAL, "new", at = Instant.now().minus(2, ChronoUnit.DAYS))

        chatService.purgeExpired()

        val remaining = chatMessageRepository.findAll().map { it.id }
        assertEquals(listOf(fresh.id), remaining)
        assertTrue(stale.id !in remaining)

        chatMessageRepository.deleteAll()
        agentRepository.deleteById(checkNotNull(agent.id))
        hostRepository.deleteById(checkNotNull(host.id))
    }

    // ---- shape ---------------------------------------------------------------------------------

    @Test
    fun `an exhausted feed reports no next cursor`() {
        val agent = createAgent("Mason_01", reachableHost())
        line(agent, ChatScope.GLOBAL, "only one")

        val body = mockMvc.get("/api/chat?server=mc.example.com:25565&limit=50") {
            header(HttpHeaders.AUTHORIZATION, authAs("reader", "viewer"))
        }.andExpect {
            status { isOk() }
            jsonPath("$.items") { value(hasSize<Any>(1)) }
        }.andReturn().response.contentAsString

        assertNull(JsonPath.read<String?>(body, "$.nextCursor"))
    }
}

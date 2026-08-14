package net.integr.osmium.mockhost

import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.MessageKind
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketHttpHeaders
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.client.standard.StandardWebSocketClient
import org.springframework.web.socket.handler.TextWebSocketHandler
import tools.jackson.databind.ObjectMapper
import tools.jackson.module.kotlin.jacksonObjectMapper
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * A host that speaks the protocol and runs no Minecraft.
 *
 * Every screen in Osmium that shows reported data - telemetry, nearby players, chat, activity, the
 * dashboard trends - stays empty until something dials in. This is that something, so the interface
 * can be developed and looked at without a game client, an account or a server.
 *
 * **It is a second implementation of the wire protocol, and that is most of its value.** The real
 * host is written elsewhere in Rust; until now the only thing exercising `HostEnvelope` was the
 * backend's own tests, which assert against the same constants they are testing. This shares those
 * constants deliberately: rename a command and this stops compiling, rather than drifting quietly
 * and being discovered by the other developer.
 *
 * What it deliberately does **not** do: log in to anything, hold a credential, or model Minecraft.
 * Setup succeeds because it is told to, and reports an invented identity. The real login is the
 * host's business and the backend never observes it - see FLEET_CONNECTIVITY.md.
 *
 * Lives in its own source set, so it is not on the application's classpath and cannot reach the
 * published image.
 */
fun main() {
    val token = System.getenv("OSMIUM_HOST_TOKEN")
    require(!token.isNullOrBlank()) {
        "Set OSMIUM_HOST_TOKEN to a host enrolment token. Enrol a host in the interface and copy " +
            "the token it shows once."
    }

    val url = System.getenv("OSMIUM_HOST_URL") ?: DEFAULT_URL
    MockHost(url = url, token = token).run()
}

private const val DEFAULT_URL = "ws://localhost:8080/ws/host"

/** Fast enough to watch a trend build, slow enough to read the log. */
private const val HEARTBEAT_SECONDS = 10L
private const val TELEMETRY_SECONDS = 3L
private const val CHATTER_SECONDS = 12L

/** Backs off from a second to half a minute, like every other reconnecting client here. */
private const val FIRST_RETRY_MILLIS = 1_000L
private const val MAX_RETRY_MILLIS = 30_000L

/** Below this, a connection did not really work and must not reset the backoff. */
private const val HEALTHY_MILLIS = 5_000L

class MockHost(private val url: String, private val token: String) {

    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val clock = Executors.newScheduledThreadPool(2)

    /**
     * The agents this host has been told about, by id.
     *
     * A real host knows only what it has been commanded to run, so this is populated by commands
     * rather than by asking the backend. Reporting on an agent nobody assigned here would be a
     * fiction the real host could not produce.
     */
    private val agents = ConcurrentHashMap<Long, MockAgent>()

    private lateinit var session: WebSocketSession

    @Volatile private var stopped = false
    private var backoff = FIRST_RETRY_MILLIS

    fun run() {
        Runtime.getRuntime().addShutdownHook(Thread {
            stopped = true
            clock.shutdownNow()
            runCatching { if (::session.isInitialized) session.close(CloseStatus.NORMAL) }
        })

        clock.scheduleAtFixedRate(::heartbeat, 0, HEARTBEAT_SECONDS, TimeUnit.SECONDS)
        clock.scheduleAtFixedRate(::telemetry, TELEMETRY_SECONDS, TELEMETRY_SECONDS, TimeUnit.SECONDS)
        clock.scheduleAtFixedRate(::chatter, CHATTER_SECONDS, CHATTER_SECONDS, TimeUnit.SECONDS)

        // Reconnecting rather than exiting, because the backend it talks to is a development server
        // that restarts on every save. A tool that has to be started again after each one is a tool
        // nobody leaves running.
        while (!stopped) {
            if (connect()) {
                val openedAt = System.currentTimeMillis()
                while (!stopped && session.isOpen) Thread.sleep(200)
                if (stopped) return

                val lived = System.currentTimeMillis() - openedAt
                if (lived >= HEALTHY_MILLIS) {
                    backoff = FIRST_RETRY_MILLIS
                    println("connection lost")
                } else {
                    // The backend closes the previous session when a host reconnects, so two
                    // processes holding one token evict each other forever — and each reports its
                    // own idea of which agents are online, so a disconnect gets undone a second
                    // later by the other one. Resetting the backoff on a connection this short is
                    // what makes that a tight loop instead of an obvious problem.
                    println(
                        "closed after ${lived}ms — another process is probably using this host " +
                            "token. Backing off ${backoff / 1000}s.",
                    )
                }
            }
            if (stopped) return
            Thread.sleep(backoff)
            backoff = (backoff * 2).coerceAtMost(MAX_RETRY_MILLIS)
        }
    }

    private fun connect(): Boolean = runCatching {
        val headers = WebSocketHttpHeaders().apply { add("Authorization", "Bearer $token") }
        session = StandardWebSocketClient()
            .execute(Handler(), headers, URI.create(url))
            .get(10, TimeUnit.SECONDS)

        println("connected to $url")
        // The agents are the host's own memory of what it was told to run, and the backend does not
        // re-issue commands on reconnect. Anything already online says so again, or it would sit in
        // the interface as ONLINE with vitals that stopped arriving.
        for ((agentId, agent) in agents) if (agent.online) state(agentId, "ONLINE")
        true
    }.getOrElse {
        println("connect failed (${it.message}), retrying in ${backoff / 1000}s")
        false
    }

    private inner class Handler : TextWebSocketHandler() {
        override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
            val envelope = runCatching {
                mapper.readValue(message.payload, HostEnvelope::class.java)
            }.getOrElse {
                println("unparseable frame: ${message.payload}")
                return
            }

            if (envelope.kind != MessageKind.COMMAND) return
            println("<- ${envelope.type}${envelope.agentId?.let { " agent=$it" } ?: ""}")
            onCommand(envelope)
        }

        // No teardown here: the run loop notices the closed session and dials again. Stopping the
        // scheduler would end the process on the first restart of the backend.
        override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
            println("disconnected: $status")
        }
    }

    private fun onCommand(command: HostEnvelope) {
        val agentId = command.agentId
        when (command.type) {
            // Answered after a beat, because instant success hides every "pending" state the
            // interface has to render.
            CommandType.SETUP_AGENT -> {
                if (agentId == null) return
                clock.schedule({ completeSetup(command, agentId) }, 2, TimeUnit.SECONDS)
            }

            CommandType.CONNECT -> {
                if (agentId == null) return
                agents.computeIfAbsent(agentId, ::MockAgent).online = true
                result(command, ok = true)
                state(agentId, "ONLINE")
                activity(agentId, "lifecycle", "info", "Joined the server")
            }

            CommandType.DISCONNECT -> {
                if (agentId == null) return
                agents[agentId]?.online = false
                result(command, ok = true)
                state(agentId, "LINKED")
                activity(agentId, "lifecycle", "info", "Left the server")
            }

            // Echoed back as an event, which is what puts it in the feed: the backend records what
            // reached the server, not what was dispatched.
            CommandType.CHAT -> {
                if (agentId == null) return
                result(command, ok = true)
                val text = command.payload?.get("message")?.asString() ?: return
                // computeIfAbsent, not a lookup with a fallback: this host restarts and forgets, and
                // the name is derived from the id, so it is the same one either way. Looking it up
                // and giving up produced lines attributed to "agent" after every reconnect.
                val speaker = agents.computeIfAbsent(agentId, ::MockAgent).username
                chat(agentId, scope = "outbound", from = speaker, text = text)
            }

            CommandType.SET_CHAT_LISTENER -> result(command, ok = true)

            else -> println("ignoring unknown command '${command.type}'")
        }
    }

    private fun completeSetup(command: HostEnvelope, agentId: Long) {
        val agent = agents.computeIfAbsent(agentId, ::MockAgent)
        send(
            HostEnvelope(
                id = command.id,
                kind = MessageKind.RESULT,
                type = EventType.SETUP_RESULT,
                agentId = agentId,
                ok = true,
                // Identity only. A real host would have obtained this by logging in; there is no
                // credential here and none is sent.
                payload = mapper.valueToTree(
                    mapOf("mcUsername" to agent.username, "mcUuid" to agent.uuid),
                ),
            ),
        )
    }

    private fun heartbeat() = send(
        HostEnvelope(
            kind = MessageKind.EVENT,
            type = EventType.HEARTBEAT,
            payload = mapper.valueToTree(mapOf("hostVersion" to "mock-host")),
        ),
    )

    /**
     * Vitals for every agent in game.
     *
     * All four core readings go together on purpose: the backend drops a partial sample rather than
     * defaulting one, because an absent `food` read as `0` renders as a starving agent. Sending them
     * as a set is what a real host has to do too.
     */
    private fun telemetry() {
        for ((agentId, agent) in agents) {
            if (!agent.online) continue
            agent.wander()

            send(
                HostEnvelope(
                    kind = MessageKind.EVENT,
                    type = EventType.AGENT_STATUS,
                    agentId = agentId,
                    payload = mapper.valueToTree(
                        mapOf(
                            "state" to "ONLINE",
                            "health" to agent.health,
                            "food" to agent.food,
                            "pingMs" to agent.ping,
                            "position" to mapOf("x" to agent.x, "y" to agent.y, "z" to agent.z),
                            "dimension" to "overworld",
                            "nearby" to agent.nearby(),
                        ),
                    ),
                ),
            )
        }
    }

    /** Somebody says something occasionally, so the chat rail has traffic to show. */
    private fun chatter() {
        val online = agents.filterValues { it.online }.keys.toList()
        if (online.isEmpty()) return
        val agentId = online.random()

        if (Random.nextInt(3) == 0) {
            activity(agentId, "system", listOf("info", "warning").random(), INCIDENTS.random())
            return
        }
        chat(agentId, scope = "global", from = STRANGERS.random(), text = SMALL_TALK.random())
    }

    private fun chat(agentId: Long, scope: String, from: String, text: String) = send(
        HostEnvelope(
            kind = MessageKind.EVENT,
            type = EventType.CHAT,
            agentId = agentId,
            payload = mapper.valueToTree(mapOf("scope" to scope, "from" to from, "text" to text)),
        ),
    )

    private fun activity(agentId: Long, scope: String, severity: String, text: String) = send(
        HostEnvelope(
            kind = MessageKind.EVENT,
            type = EventType.ACTIVITY,
            agentId = agentId,
            payload = mapper.valueToTree(
                mapOf("scope" to scope, "severity" to severity, "text" to text),
            ),
        ),
    )

    private fun state(agentId: Long, state: String) = send(
        HostEnvelope(
            kind = MessageKind.EVENT,
            type = EventType.AGENT_STATUS,
            agentId = agentId,
            payload = mapper.valueToTree(mapOf("state" to state)),
        ),
    )

    private fun result(command: HostEnvelope, ok: Boolean) = send(
        HostEnvelope(id = command.id, kind = MessageKind.RESULT, type = command.type, agentId = command.agentId, ok = ok),
    )

    @Synchronized
    private fun send(envelope: HostEnvelope) {
        if (!::session.isInitialized || !session.isOpen) return
        runCatching { session.sendMessage(TextMessage(mapper.writeValueAsString(envelope))) }
            .onFailure { println("send failed: ${it.message}") }
    }
}

/** One simulated agent. Deterministic identity, drifting vitals. */
private class MockAgent(agentId: Long) {
    val username = "Mock_%02d".format(agentId)

    /** A stable, syntactically valid UUID per agent, so avatars and the head cache behave. */
    val uuid = "00000000-0000-4000-8000-%012d".format(agentId)

    @Volatile var online = false

    var health = 20
    var food = 18
    var ping = 45
    var x = Random.nextDouble(-200.0, 200.0)
    var y = 64.0
    var z = Random.nextDouble(-200.0, 200.0)

    /** Small random steps rather than teleports, so the position reads as an agent doing something. */
    fun wander() {
        x = (x + Random.nextDouble(-3.0, 3.0)).coerceIn(-500.0, 500.0)
        z = (z + Random.nextDouble(-3.0, 3.0)).coerceIn(-500.0, 500.0)
        y = (y + Random.nextDouble(-0.6, 0.6)).coerceIn(56.0, 90.0)
        health = (health + Random.nextInt(-1, 2)).coerceIn(6, 20)
        food = (food + Random.nextInt(-1, 2)).coerceIn(4, 20)
        ping = (ping + Random.nextInt(-8, 9)).coerceIn(12, 320)
    }

    fun nearby(): List<Map<String, Any>> =
        if (Random.nextInt(3) != 0) emptyList()
        else listOf(
            mapOf(
                "name" to STRANGERS.random(),
                "distance" to (Random.nextDouble(2.0, 40.0) * 10).roundToInt() / 10.0,
                "position" to mapOf("x" to x + 4, "y" to y, "z" to z - 3),
            ),
        )
}

private val STRANGERS = listOf("Notch", "Steve", "Alex", "dinnerbone", "Herobrine_", "gravel_eater")

private val SMALL_TALK = listOf(
    "anyone got spare cobble",
    "who built this",
    "brb food",
    "nice base",
    "is the nether portal linked",
    "lag?",
)

private val INCIDENTS = listOf(
    "Kicked: flying is not enabled on this server",
    "Took fall damage",
    "Inventory full, stopped collecting",
    "Path blocked, recalculating",
    "Server TPS dropped below 15",
)

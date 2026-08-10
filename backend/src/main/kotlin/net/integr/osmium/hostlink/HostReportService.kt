package net.integr.osmium.hostlink

import tools.jackson.databind.JsonNode
import net.integr.osmium.agent.dto.AgentTelemetryResponse
import net.integr.osmium.agent.dto.NearbyPlayerResponse
import net.integr.osmium.agent.dto.PositionResponse
import net.integr.osmium.agent.dto.toResponse
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.service.AgentTelemetryPublisher
import net.integr.osmium.agent.service.AgentTelemetryStore
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import net.integr.osmium.activity.service.ActivityService
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.chat.model.ChatScope
import net.integr.osmium.chat.service.ChatService
import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.MessageKind
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import net.integr.osmium.host.model.Host
import net.integr.osmium.host.service.HostService

/**
 * Applies what a host reports. The host is the source of truth about its own agents: the backend
 * records what it is told rather than asserting state back.
 */
@Service
class HostReportService(
    private val agentRepository: AgentRepository,
    private val hostService: HostService,
    private val chatService: ChatService,
    private val activityService: ActivityService,
    private val telemetryStore: AgentTelemetryStore,
    private val telemetryPublisher: AgentTelemetryPublisher,
    private val broker: FleetEventBroker,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Transactional
    fun onConnected(hostId: Long, remoteAddress: String?) {
        hostService.recordHeartbeat(hostId = hostId, hostVersion = null, address = remoteAddress)
    }

    @Transactional
    fun onMessage(hostId: Long, envelope: HostEnvelope) {
        when (envelope.kind) {
            MessageKind.EVENT -> onEvent(hostId, envelope)
            MessageKind.RESULT -> onResult(hostId, envelope)
            // The backend issues commands; it does not take them.
            MessageKind.COMMAND -> log.warn("Host {} sent a command '{}', ignoring", hostId, envelope.type)
        }
    }

    private fun onEvent(hostId: Long, envelope: HostEnvelope) {
        when (envelope.type) {
            EventType.HEARTBEAT -> hostService.recordHeartbeat(
                hostId = hostId,
                hostVersion = envelope.payload?.get("hostVersion")?.asString(),
                address = null,
            )

            EventType.AGENT_STATUS -> applyStatus(hostId, envelope)

            EventType.CHAT -> recordChat(hostId, envelope)

            EventType.ACTIVITY -> recordActivity(hostId, envelope)

            // Forward compatible by design: a newer host reporting something this backend has not
            // learned about yet is normal, so it is logged and dropped rather than fatal.
            else -> log.debug("Ignoring unknown event '{}' from host {}", envelope.type, hostId)
        }
    }

    private fun onResult(hostId: Long, envelope: HostEnvelope) {
        if (envelope.type == EventType.SETUP_RESULT || envelope.type == "setup_agent") {
            applySetupResult(hostId, envelope)
            return
        }
        log.debug("Result for '{}' (id={}) from host {}", envelope.type, envelope.id, hostId)
    }

    private fun applySetupResult(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return

        if (envelope.ok == true) {
            agent.state = AgentState.LINKED
            // Identity only. A credential must never appear here, and is not read if it does.
            agent.mcUsername = envelope.payload?.get("mcUsername")?.asString()
            agent.mcUuid = envelope.payload?.get("mcUuid")?.asString()
            publish(agent)
        } else {
            // Back to where it started, so the operator can retry rather than being stuck pending.
            agent.state = AgentState.UNLINKED
            log.info(
                "Setup failed for agent {}: {}",
                agent.label,
                envelope.payload?.get("reason")?.asString() ?: "no reason given",
            )
            publish(agent)
        }
    }

    /**
     * `agent_status` carries two things with very different lifetimes, and they are handled apart.
     *
     * The **state** is a rare, durable fact: it is written and published only when it actually
     * changes, so a host reporting `ONLINE` every few seconds costs nothing. The **telemetry** is a
     * continuous sample: taken every time, kept in memory, and published on its own lightweight
     * event rather than re-sending the whole agent. Treating them alike would mean either an
     * `agent` event per tick, or vitals that only update when an agent connects.
     *
     * Either half may be absent. A host with nothing new to say about state can send telemetry
     * alone, and vice versa.
     */
    private fun applyStatus(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        applyState(hostId, agent, envelope)
        applyTelemetry(agent, envelope)
    }

    private fun applyState(hostId: Long, agent: Agent, envelope: HostEnvelope) {
        val reported = envelope.payload?.get("state")?.asString() ?: return

        val state = runCatching { AgentState.valueOf(reported) }.getOrNull()
        if (state == null) {
            log.debug("Ignoring unknown agent state '{}' from host {}", reported, hostId)
            return
        }
        // STALE is derived from host reachability, never reported: a host that can talk to us is
        // by definition not stale.
        if (state == AgentState.STALE) return

        // The whole point of the live channel: a state change the operator did not cause is the one
        // thing polling would otherwise have to discover.
        if (agent.state != state) {
            agent.state = state
            // Chat listener election ranks by session length, so the clock starts on entering the
            // game and stops on leaving it. A reconnect is a new session, not a continuation.
            agent.onlineSince = if (state == AgentState.ONLINE) Instant.now() else null
            // An agent that left the game has stopped forwarding whatever it was forwarding. Saying
            // so here means the next election sees a vacancy rather than a listener that is gone.
            if (state != AgentState.ONLINE) agent.chatListener = false
            publish(agent)
        }
    }

    private fun applyTelemetry(agent: Agent, envelope: HostEnvelope) {
        val payload = envelope.payload ?: return
        // Vitals arrive together or not at all; health is the marker for "this tick carries them".
        val health = payload.get("health")?.asInt() ?: return
        val agentId = agent.id ?: return

        val telemetry = AgentTelemetryResponse(
            health = health,
            food = payload.get("food")?.asInt() ?: 0,
            position = payload.get("position").let {
                PositionResponse(
                    x = it?.get("x")?.asDouble() ?: 0.0,
                    y = it?.get("y")?.asDouble() ?: 0.0,
                    z = it?.get("z")?.asDouble() ?: 0.0,
                )
            },
            dimension = payload.get("dimension")?.asString() ?: "overworld",
            pingMs = payload.get("pingMs")?.asInt() ?: 0,
            nearby = nearbyFrom(payload),
        )

        telemetryStore.record(agentId, telemetry)
        // Marked rather than published. Reports arrive as fast as hosts choose to send them; the
        // browser is fed on a fixed tick carrying the latest reading. See AgentTelemetryPublisher.
        telemetryPublisher.reported(agentId)
    }

    /**
     * Whether a nearby player is one of ours is decided **here, not by the host**. A host sees only
     * its own agents, and a server's fleet can span several hosts, so it cannot tell one of ours
     * from a stranger. The host reports names and distances; the backend knows the fleet.
     */
    private fun nearbyFrom(payload: JsonNode): List<NearbyPlayerResponse> {
        val reported = payload.get("nearby")?.takeIf { it.isArray } ?: return emptyList()
        if (reported.isEmpty) return emptyList()

        val ours = agentRepository.findAll().mapNotNullTo(mutableSetOf()) { it.mcUsername?.lowercase() }

        return reported.mapNotNull { entry ->
            val name = entry.get("name")?.asString() ?: return@mapNotNull null
            NearbyPlayerResponse(
                name = name,
                distance = entry.get("distance")?.asDouble() ?: 0.0,
                isAgent = name.lowercase() in ours,
            )
        }
    }

    /**
     * A line the host classified. An unrecognised scope is dropped rather than guessed at: filing
     * chat into the wrong feed is worse than losing it, since the whole point of the split is that
     * an incident is not buried in conversation.
     */
    private fun recordChat(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        val payload = envelope.payload ?: return

        val scope = enumOrNull<ChatScope>(payload.get("scope")?.asString())
        val text = payload.get("text")?.asString()
        if (scope == null || text.isNullOrBlank()) {
            log.debug("Ignoring malformed chat event from host {}", hostId)
            return
        }

        chatService.record(
            agent = agent,
            scope = scope,
            // Falls back to the agent's own name, which is who said it when the scope is outbound.
            from = payload.get("from")?.asString() ?: agent.label,
            text = text,
        )
    }

    private fun recordActivity(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        val payload = envelope.payload ?: return

        val scope = enumOrNull<ActivityScope>(payload.get("scope")?.asString())
        val text = payload.get("text")?.asString()
        if (scope == null || text.isNullOrBlank()) {
            log.debug("Ignoring malformed activity event from host {}", hostId)
            return
        }

        activityService.record(
            agent = agent,
            scope = scope,
            // Optional on the wire: a host that reports what happened without rating it still gets
            // the line recorded, and INFO is the reading that claims least.
            severity = enumOrNull<ActivitySeverity>(payload.get("severity")?.asString())
                ?: ActivitySeverity.INFO,
            text = text,
        )
    }

    /** Wire values are lower case; an unknown one is null rather than an exception. */
    private inline fun <reified T : Enum<T>> enumOrNull(raw: String?): T? =
        raw?.let { value -> enumValues<T>().firstOrNull { it.name.equals(value, ignoreCase = true) } }

    private fun publish(agent: Agent) = broker.publish(
        // Telemetry is looked up rather than omitted: this event replaces the agent in the browser,
        // so leaving it null would read as "stopped reporting" every time the state changed.
        FleetEvent(
            type = FleetEventType.AGENT_CHANGED,
            data = agent.toResponse(telemetryStore.find(agent.id)),
            agentId = agent.id,
        ),
    )

    /** Rejects a host reporting on an agent it does not own, rather than trusting the agentId. */
    private fun resolve(hostId: Long, envelope: HostEnvelope) =
        envelope.agentId
            ?.let { agentRepository.findById(it).orElse(null) }
            ?.takeIf { it.host.id == hostId }
            ?: run {
                log.warn("Host {} reported on agent {} it does not own", hostId, envelope.agentId)
                null
            }
}

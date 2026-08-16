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
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateType
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
    private val broker: LiveUpdateBroker,
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

            EventType.HANDSHAKE -> handshake(hostId, envelope)

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
     * What a host says it is, on arrival: what it is running, and what it can log in with.
     *
     * Two independent halves of one message, and each key is optional, so a host that only
     * implements one of them is handled rather than rejected.
     */
    private fun handshake(hostId: Long, envelope: HostEnvelope) {
        envelope.payload?.get("loginMethods")?.takeIf { it.isArray }?.let { advertised ->
            // Copy is optional and only ever shown; the id is the part that has to be there,
            // because it is what comes back in setup_agent.
            val methods = advertised.mapNotNull { node ->
                node.get("id")?.asString()?.takeIf { it.isNotBlank() }?.let { id ->
                    LoginMethod(
                        id = id,
                        label = node.get("label")?.asString(),
                        description = node.get("description")?.asString(),
                    )
                }
            }
            hostService.recordLoginMethods(hostId, methods)
        }

        envelope.payload?.get("agents")?.takeIf { it.isArray }?.let { reconcile(hostId, it) }
    }

    /**
     * Squares what a host says it is running against what the backend believed.
     *
     * Announced agents are applied exactly as `agent_status` would apply them, so a host that kept
     * its sessions across a socket blip changes nothing by saying so.
     *
     * An agent this host owns and did **not** mention is not in game. Its stored state is a claim
     * about a live session, and the only party that can see one has just declined to mention it:
     *
     * - `ONLINE` becomes `LINKED`. The credentials are on the host's disk and outlive a restart;
     *   the session does not.
     * - `SETUP_PENDING` becomes `UNLINKED`, the same place a failed setup lands. The command went
     *   with the process that was going to answer it, so nothing is coming.
     *
     * Every other state is left alone: none of them assert a session, so the host's silence says
     * nothing about them.
     */
    private fun reconcile(hostId: Long, reported: JsonNode) {
        val announced = reported.mapNotNull { node -> node.get("agentId")?.asLong() }.toSet()

        for (node in reported) {
            val agentId = node.get("agentId")?.asLong() ?: continue
            val agent = ownedAgent(hostId, agentId) ?: continue
            applyReportedState(hostId, agent, node.get("state")?.asString())
        }

        for (agent in agentRepository.findAllByHostId(hostId)) {
            if (agent.id in announced) continue

            val corrected = when (agent.state) {
                AgentState.ONLINE -> AgentState.LINKED
                AgentState.SETUP_PENDING -> AgentState.UNLINKED
                else -> continue
            }

            log.info("Host {} did not announce agent {}; {} -> {}", hostId, agent.label, agent.state, corrected)
            agent.state = corrected
            agent.onlineSince = null
            agent.chatListener = false
            // The operator did not cause this and would otherwise see a state change with no
            // explanation, which is exactly what the activity feed is for.
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.WARNING,
                text = "Host reconnected without this agent, so it is no longer in game",
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
        applyReportedState(hostId, agent, envelope.payload?.get("state")?.asString())
    }

    /** Shared with the arrival announcement, which reports the same states in a different shape. */
    private fun applyReportedState(hostId: Long, agent: Agent, reported: String?) {
        if (reported == null) return

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

    /**
     * Reads the vitals half, which is present only on some ticks.
     *
     * **All four core readings are required together.** Defaulting a missing one would be inventing
     * a measurement: an absent `food` becoming `0` renders as a starving agent and raises an alert
     * about an agent that is fine, and an absent `position` becoming the origin puts it somewhere it
     * has never been. That is the same fabrication `telemetry = null` exists to prevent, so a
     * partial tick is dropped whole and logged rather than patched up.
     *
     * `dimension` and `nearby` do default, because "overworld" and "nobody nearby" are cheap to be
     * wrong about and neither drives an alert.
     */
    private fun applyTelemetry(agent: Agent, envelope: HostEnvelope) {
        val payload = envelope.payload ?: return
        val agentId = agent.id ?: return

        val health = payload.get("health")?.asInt()
        val food = payload.get("food")?.asInt()
        val pingMs = payload.get("pingMs")?.asInt()
        val position = positionFrom(payload.get("position"))

        // No vitals at all is the ordinary case: this was a state report.
        if (health == null && food == null && pingMs == null && position == null) return

        if (health == null || food == null || pingMs == null || position == null) {
            log.warn(
                "Dropping a partial telemetry sample for agent {}: health, food, pingMs and position " +
                    "are required together",
                agent.label,
            )
            return
        }

        val telemetry = AgentTelemetryResponse(
            health = health,
            food = food,
            position = position,
            dimension = payload.get("dimension")?.asString() ?: "overworld",
            pingMs = pingMs,
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
     * from a stranger. The host reports names, distances and positions; the backend knows the fleet.
     *
     * A player's `position` is optional where the agent's own is required. An absent one is reported
     * as absent rather than dropping the entry: the fact that somebody is standing there matters
     * more than knowing exactly where, and a host can legitimately have the distance without a
     * usable position.
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
                position = positionFrom(entry.get("position")),
                isAgent = name.lowercase() in ours,
            )
        }
    }

    /**
     * A position, or null when any part of it is missing. All three or none — two coordinates plus a
     * guess for the third is a point nobody was ever at, and it would render as confidently as a
     * real one.
     */
    private fun positionFrom(node: JsonNode?): PositionResponse? {
        val x = node?.get("x")?.asDouble() ?: return null
        val y = node.get("y")?.asDouble() ?: return null
        val z = node.get("z")?.asDouble() ?: return null
        return PositionResponse(x = x, y = y, z = z)
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
        LiveUpdateEvent(
            type = LiveUpdateType.AGENT_CHANGED,
            data = agent.toResponse(telemetryStore.find(agent.id)),
            agentId = agent.id,
        ),
    )

    /** Rejects a host reporting on an agent it does not own, rather than trusting the agentId. */
    private fun resolve(hostId: Long, envelope: HostEnvelope) =
        envelope.agentId?.let { ownedAgent(hostId, it) }
            ?: run {
                log.warn("Host {} reported on agent {} it does not own", hostId, envelope.agentId)
                null
            }

    /** A host may only speak about the agents it owns, however the id reached us. */
    private fun ownedAgent(hostId: Long, agentId: Long): Agent? =
        agentRepository.findById(agentId).orElse(null)?.takeIf { it.host.id == hostId }
}

package net.integr.osmium.hostlink

import net.integr.osmium.agent.dto.toResponse
import net.integr.osmium.agent.model.Agent
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

            EventType.AGENT_STATUS -> applyState(hostId, envelope)

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

    private fun applyState(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
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
        FleetEvent(type = FleetEventType.AGENT_CHANGED, data = agent.toResponse(), agentId = agent.id),
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

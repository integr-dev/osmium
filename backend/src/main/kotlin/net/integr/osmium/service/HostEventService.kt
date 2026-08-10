package net.integr.osmium.service

import net.integr.osmium.dto.toResponse
import net.integr.osmium.model.Agent
import net.integr.osmium.model.AgentState
import net.integr.osmium.repository.AgentRepository
import net.integr.osmium.stream.FleetEvent
import net.integr.osmium.stream.FleetEventBroker
import net.integr.osmium.stream.FleetEventType
import net.integr.osmium.websocket.HostEnvelope
import net.integr.osmium.websocket.EventType
import net.integr.osmium.websocket.MessageKind
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * Applies what a host reports. The host is the source of truth about its own agents: the backend
 * records what it is told rather than asserting state back.
 */
@Service
class HostEventService(
    private val agentRepository: AgentRepository,
    private val hostService: HostService,
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
            publish(agent)
        }
    }

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

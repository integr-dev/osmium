package net.integr.osmium.chat.service

import net.integr.osmium.agent.dto.toResponse
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.agent.service.AgentTelemetryStore
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateType
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.time.Instant
import java.util.UUID

/**
 * Picks the one agent per **server** that forwards global chat, and tells it so.
 *
 * Global chat is identical for every agent on a server, so exactly one forwards it and the rest
 * suppress it. Election is backend-side because only the backend sees the whole fleet: agents on one
 * server can be spread across several hosts, so no host can tell whether another already has a
 * listener. See the Chat section of FLEET_CONNECTIVITY.md.
 */
@Service
class ChatListenerService(
    private val agentRepository: AgentRepository,
    private val connections: HostConnections,
    private val telemetryStore: AgentTelemetryStore,
    private val objectMapper: ObjectMapper,
    private val broker: LiveUpdateBroker,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * Re-checks every server on a timer rather than reacting to events.
     *
     * The failure this exists for produces no event at all: `STALE` is *derived* from the host's
     * heartbeat at read time, so a host going silent changes nothing in the database and fires
     * nothing. An event-driven election would leave a dead listener in place indefinitely, and that
     * server's chat would simply stop with nothing to indicate why.
     *
     * The tick is shorter than [net.integr.osmium.host.model.Host.HEARTBEAT_GRACE] so that noticing
     * a lost incumbent is bounded by the grace window rather than by this interval. Every other
     * trigger - an agent connecting, being deleted, being moved to another server - is left to the
     * same sweep, because it converges anyway and one code path cannot be forgotten at a call site.
     */
    @Scheduled(fixedDelay = RECONCILE_MS, initialDelay = RECONCILE_MS)
    @Transactional
    fun reconcileAll() {
        agentRepository.findAll()
            // An agent assigned nowhere is a candidate for nothing. Without this they would group
            // together under null and the sweep would try to elect a listener for "no server",
            // which is not a server and has no chat to forward.
            .mapNotNull { agent -> agent.serverAddress?.let { it to agent } }
            .groupBy({ it.first }, { it.second })
            .forEach { (server, agents) -> reconcile(server, agents) }
    }

    private fun reconcile(server: String, agents: List<Agent>) {
        val incumbent = agents.firstOrNull { it.chatListener }

        // Stability, not fairness: a working listener is never displaced. A new agent joining a
        // server would otherwise take the role from one that is already forwarding correctly, and
        // the handover costs a gap in the feed for nothing.
        if (incumbent != null && incumbent.isEligible()) return

        val successor = agents.filter { it.isEligible() }.minByOrNull { it.onlineSince ?: Instant.MAX }

        if (successor == null) {
            // Honest rather than tidy: nothing is listening, so the server has no global feed.
            if (incumbent != null) {
                stand(incumbent, down = true)
                log.info("Server {} has no agent online; its global chat has no listener", server)
            }
            return
        }

        // Told before recorded. The flag means "this agent was asked to listen and the write went
        // through" - setting it first would leave a server with a listener on paper and silence in
        // practice, which is the one failure the operator cannot see.
        if (!send(successor, enabled = true)) {
            log.debug("Could not reach {} to hand it the listener role on {}", successor.label, server)
            return
        }
        if (incumbent != null) stand(incumbent, down = true)
        mark(successor, listening = true)

        log.info("Agent {} now forwards global chat on {}", successor.label, server)
    }

    /**
     * Eligible means genuinely in game *and* writable.
     *
     * `effectiveState` covers the heartbeat, but a host can be inside its grace window with the
     * socket already gone - a laptop closing, a process killed. Electing an agent the backend cannot
     * write to would record a listener that never receives the command.
     */
    private fun Agent.isEligible(): Boolean =
        effectiveState() == AgentState.ONLINE && connections.isConnected(host.id ?: return false)

    /** Best effort: an agent that cannot be reached to be stood down has already stopped forwarding. */
    private fun stand(agent: Agent, down: Boolean) {
        send(agent, enabled = !down)
        mark(agent, listening = !down)
    }

    private fun mark(agent: Agent, listening: Boolean) {
        if (agent.chatListener == listening) return
        agent.chatListener = listening
        agentRepository.save(agent)
        broker.publish(
            // Looked up rather than left null: this event replaces the agent in the browser, so
            // omitting telemetry would blank an agent's vitals every time the listener role moved.
            LiveUpdateEvent(
                type = LiveUpdateType.AGENT_CHANGED,
                data = agent.toResponse(telemetryStore.find(agent.id)),
                agentId = agent.id,
            ),
        )
    }

    private fun send(agent: Agent, enabled: Boolean): Boolean {
        val hostId = agent.host.id ?: return false
        return connections.send(
            hostId,
            HostEnvelope(
                id = "cmd-${UUID.randomUUID()}",
                kind = MessageKind.COMMAND,
                type = CommandType.SET_CHAT_LISTENER,
                agentId = agent.id,
                payload = objectMapper.valueToTree(mapOf("enabled" to enabled)),
            ),
        )
    }

    private companion object {
        /** 10s: comfortably inside the 30s heartbeat grace, so the grace window is what bounds it. */
        const val RECONCILE_MS = 10_000L
    }
}

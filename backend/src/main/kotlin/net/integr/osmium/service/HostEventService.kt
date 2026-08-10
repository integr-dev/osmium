package net.integr.osmium.service

import net.integr.osmium.model.BotState
import net.integr.osmium.repository.BotRepository
import net.integr.osmium.websocket.AgentEnvelope
import net.integr.osmium.websocket.EventType
import net.integr.osmium.websocket.MessageKind
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * Applies what an agent reports. The agent is the source of truth about its own bots: the backend
 * records what it is told rather than asserting state back.
 */
@Service
class AgentEventService(
    private val botRepository: BotRepository,
    private val hostService: HostService,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Transactional
    fun onConnected(hostId: Long, remoteAddress: String?) {
        hostService.recordHeartbeat(hostId = hostId, agentVersion = null, address = remoteAddress)
    }

    @Transactional
    fun onMessage(hostId: Long, envelope: AgentEnvelope) {
        when (envelope.kind) {
            MessageKind.EVENT -> onEvent(hostId, envelope)
            MessageKind.RESULT -> onResult(hostId, envelope)
            // The backend issues commands; it does not take them.
            MessageKind.COMMAND -> log.warn("Host {} sent a command '{}', ignoring", hostId, envelope.type)
        }
    }

    private fun onEvent(hostId: Long, envelope: AgentEnvelope) {
        when (envelope.type) {
            EventType.HEARTBEAT -> hostService.recordHeartbeat(
                hostId = hostId,
                agentVersion = envelope.payload?.get("agentVersion")?.asString(),
                address = null,
            )

            EventType.BOT_STATUS -> applyState(hostId, envelope)

            // Forward compatible by design: a newer agent reporting something this backend has not
            // learned about yet is normal, so it is logged and dropped rather than fatal.
            else -> log.debug("Ignoring unknown event '{}' from host {}", envelope.type, hostId)
        }
    }

    private fun onResult(hostId: Long, envelope: AgentEnvelope) {
        if (envelope.type == EventType.SETUP_RESULT || envelope.type == "setup_bot") {
            applySetupResult(hostId, envelope)
            return
        }
        log.debug("Result for '{}' (id={}) from host {}", envelope.type, envelope.id, hostId)
    }

    private fun applySetupResult(hostId: Long, envelope: AgentEnvelope) {
        val bot = resolve(hostId, envelope) ?: return

        if (envelope.ok == true) {
            bot.state = BotState.LINKED
            // Identity only. A credential must never appear here, and is not read if it does.
            bot.mcUsername = envelope.payload?.get("mcUsername")?.asString()
            bot.mcUuid = envelope.payload?.get("mcUuid")?.asString()
        } else {
            // Back to where it started, so the operator can retry rather than being stuck pending.
            bot.state = BotState.UNLINKED
            log.info(
                "Setup failed for bot {}: {}",
                bot.label,
                envelope.payload?.get("reason")?.asString() ?: "no reason given",
            )
        }
    }

    private fun applyState(hostId: Long, envelope: AgentEnvelope) {
        val bot = resolve(hostId, envelope) ?: return
        val reported = envelope.payload?.get("state")?.asString() ?: return

        val state = runCatching { BotState.valueOf(reported) }.getOrNull()
        if (state == null) {
            log.debug("Ignoring unknown bot state '{}' from host {}", reported, hostId)
            return
        }
        // STALE is derived from host reachability, never reported: an agent that can talk to us is
        // by definition not stale.
        if (state != BotState.STALE) bot.state = state
    }

    /** Rejects a host reporting on a bot it does not own, rather than trusting the botId. */
    private fun resolve(hostId: Long, envelope: AgentEnvelope) =
        envelope.botId
            ?.let { botRepository.findById(it).orElse(null) }
            ?.takeIf { it.host.id == hostId }
            ?: run {
                log.warn("Host {} reported on bot {} it does not own", hostId, envelope.botId)
                null
            }
}

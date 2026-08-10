package net.integr.osmium.service

import net.integr.osmium.dto.BotResponse
import net.integr.osmium.dto.ChatRequest
import net.integr.osmium.dto.CreateBotRequest
import net.integr.osmium.dto.SetupBotRequest
import net.integr.osmium.dto.UpdateBotRequest
import net.integr.osmium.model.Bot
import net.integr.osmium.model.BotState
import net.integr.osmium.repository.BotRepository
import net.integr.osmium.repository.HostRepository
import net.integr.osmium.websocket.AgentEnvelope
import net.integr.osmium.websocket.AgentSessionRegistry
import net.integr.osmium.websocket.CommandType
import net.integr.osmium.websocket.MessageKind
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.util.UUID

@Service
@Transactional(readOnly = true)
class BotService(
    private val botRepository: BotRepository,
    private val hostRepository: HostRepository,
    private val registry: AgentSessionRegistry,
    private val objectMapper: ObjectMapper,
) {
    fun findAll(): List<BotResponse> =
        botRepository.findAll().sortedBy { it.label }.map { it.toResponse() }

    fun findById(id: Long): BotResponse = require(id).toResponse()

    @Transactional
    fun create(request: CreateBotRequest): BotResponse {
        check(!botRepository.existsByLabel(request.label)) {
            "Bot '${request.label}' already exists"
        }
        val host = hostRepository.findById(request.hostId)
            .orElseThrow { IllegalArgumentException("No host with id ${request.hostId}") }

        val bot = Bot(
            label = request.label,
            host = host,
            serverAddress = normalizeServer(request.serverAddress),
            state = BotState.UNLINKED,
        )
        return botRepository.save(bot).toResponse()
    }

    /**
     * Renames a bot and/or moves it to another Minecraft server.
     *
     * A move leaves credentials untouched: the account is the same account whichever server it
     * joins. It does require the bot to be offline, because the server address is what the next
     * connection targets, and a bot is one session on one server.
     */
    @Transactional
    fun update(id: Long, request: UpdateBotRequest): BotResponse {
        val bot = require(id)

        request.label?.let { label ->
            require(label.isNotBlank()) { "Label must not be blank" }
            if (label != bot.label) {
                check(!botRepository.existsByLabel(label)) { "Bot '$label' already exists" }
                bot.label = label
            }
        }

        request.serverAddress?.let { address ->
            require(address.isNotBlank()) { "Server address must not be blank" }
            val moved = normalizeServer(address)
            if (moved != bot.serverAddress) {
                check(bot.state != BotState.ONLINE) {
                    "Disconnect '${bot.label}' before moving it to another server"
                }
                bot.serverAddress = moved
            }
        }

        return bot.toResponse()
    }

    @Transactional
    fun delete(id: Long) {
        botRepository.delete(require(id))
    }

    /**
     * Asks the host to set the bot up. The backend does not perform or observe the login - it sends
     * the command and waits for the host's verdict, which is why this only moves the bot to
     * SETUP_PENDING. See BOT_CONNECTIVITY.md, Phase 2.
     */
    @Transactional
    fun setup(id: Long, request: SetupBotRequest): BotResponse {
        val bot = require(id)
        check(bot.state != BotState.SETUP_PENDING) { "Setup for '${bot.label}' is already in progress" }
        check(bot.state != BotState.ONLINE) { "Disconnect '${bot.label}' before setting it up again" }

        // The method is a mechanism selector the operator chose, relayed uninterpreted. It must
        // never carry an account hint - see the wire protocol section of BOT_CONNECTIVITY.md.
        dispatch(
            bot = bot,
            type = CommandType.SETUP_BOT,
            payload = mapOf(
                "label" to bot.label,
                "serverAddress" to bot.serverAddress,
                "method" to request.method,
            ),
        )
        bot.state = BotState.SETUP_PENDING
        return bot.toResponse()
    }

    @Transactional
    fun connect(id: Long): BotResponse {
        val bot = require(id)
        check(bot.state in CONNECTABLE) {
            "'${bot.label}' cannot connect from ${bot.state}; it must be set up first"
        }
        dispatch(bot, CommandType.CONNECT, mapOf("serverAddress" to bot.serverAddress))
        return bot.toResponse()
    }

    @Transactional
    fun disconnect(id: Long): BotResponse {
        val bot = require(id)
        check(bot.state == BotState.ONLINE) { "'${bot.label}' is not online" }
        dispatch(bot, CommandType.DISCONNECT)
        return bot.toResponse()
    }

    @Transactional
    fun chat(id: Long, request: ChatRequest): BotResponse {
        val bot = require(id)
        check(bot.state == BotState.ONLINE) { "'${bot.label}' is not online" }
        dispatch(bot, CommandType.CHAT, mapOf("message" to request.message))
        return bot.toResponse()
    }

    /**
     * Sends one command to the host that owns this bot, and fails immediately if there is no live
     * agent to take it. Commands are never queued: one firing long after an operator has resolved
     * things by hand is worse than an outright failure.
     *
     * Fire and forget by design. The agent is the source of truth about its bots, so state advances
     * when it reports back, not when the command is accepted here.
     */
    private fun dispatch(bot: Bot, type: String, payload: Map<String, Any?> = emptyMap()) {
        val hostId = checkNotNull(bot.host.id) { "Host has not been persisted yet" }

        val envelope = AgentEnvelope(
            id = "cmd-${UUID.randomUUID()}",
            kind = MessageKind.COMMAND,
            type = type,
            botId = bot.id,
            payload = objectMapper.valueToTree(payload),
        )
        if (!registry.send(hostId, envelope)) throw HostUnreachableException(bot.host.name)
    }

    private fun require(id: Long): Bot =
        botRepository.findById(id).orElseThrow { NoSuchElementException("No bot with id $id") }

    private fun Bot.toResponse(): BotResponse = BotResponse(
        id = checkNotNull(id) { "Bot has not been persisted yet" },
        label = label,
        hostId = checkNotNull(host.id) { "Host has not been persisted yet" },
        hostName = host.name,
        serverAddress = serverAddress,
        state = effectiveState(),
        mcUsername = mcUsername,
        mcUuid = mcUuid,
    )

    /**
     * The server address is a grouping key - for chat listener election, builds and progress - so
     * `mc.example.com` and `mc.example.com:25565` must not become two servers. Grouping on the raw
     * string would split them silently, and the symptom would surface far from the cause.
     *
     * Deliberately simple: a bracketed IPv6 literal without a port is left alone rather than
     * mangled, since it already contains colons.
     */
    private fun normalizeServer(address: String): String {
        val trimmed = address.trim().lowercase()
        return if (trimmed.contains(':')) trimmed else "$trimmed:$DEFAULT_PORT"
    }

    private companion object {
        val CONNECTABLE = setOf(BotState.LINKED, BotState.CONNECT_FAILED, BotState.STALE)
        const val DEFAULT_PORT = 25565
    }
}

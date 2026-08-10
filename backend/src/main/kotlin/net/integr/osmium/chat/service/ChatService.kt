package net.integr.osmium.chat.service

import net.integr.osmium.agent.model.Agent
import net.integr.osmium.chat.config.ChatProperties
import net.integr.osmium.chat.dto.ChatPageResponse
import net.integr.osmium.chat.dto.toResponse
import net.integr.osmium.chat.model.ChatMessage
import net.integr.osmium.chat.model.ChatScope
import net.integr.osmium.chat.repository.ChatMessageRepository
import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import net.integr.osmium.web.PageCursor
import org.slf4j.LoggerFactory
import org.springframework.data.domain.Limit
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

/**
 * Stores and serves Minecraft chat.
 *
 * Two feeds out of one table, because they answer different questions. The **agent** feed is the
 * conversation to or about one agent; the **server** feed is what everyone on that server can see,
 * forwarded once by the elected listener. See the Chat section of FLEET_CONNECTIVITY.md.
 */
@Service
@Transactional(readOnly = true)
class ChatService(
    private val chatMessageRepository: ChatMessageRepository,
    private val chatProperties: ChatProperties,
    private val broker: FleetEventBroker,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * Records a line a host reported and pushes it straight to anyone watching.
     *
     * The label and server are copied off the agent rather than referenced, so the line survives its
     * agent being deleted - which for a server feed matters, since the listener role moves.
     */
    @Transactional
    fun record(agent: Agent, scope: ChatScope, from: String, text: String): ChatMessage {
        val saved = chatMessageRepository.save(
            ChatMessage(
                at = Instant.now(),
                agentId = agent.id,
                agentLabel = agent.label,
                serverAddress = agent.serverAddress,
                scope = scope,
                sender = from.take(ChatMessage.SENDER_MAX),
                text = text.take(ChatMessage.TEXT_MAX),
            ),
        )
        broker.publish(
            FleetEvent(type = FleetEventType.CHAT_MESSAGE, data = saved.toResponse(), agentId = agent.id),
        )
        return saved
    }

    /**
     * One agent's conversation.
     *
     * [ChatScope.GLOBAL] is excluded: it is identical for every agent on the server, so including it
     * would bury the messages that are actually to or about this agent under the server's small
     * talk. It is served by [findForServer] instead.
     */
    fun findForAgent(agentId: Long, limit: Int, cursor: String?): ChatPageResponse {
        val (beforeAt, beforeId) = PageCursor.decode(cursor)
        return page(
            chatMessageRepository.pageForAgent(
                beforeAt = beforeAt,
                beforeId = beforeId,
                agentId = agentId,
                scopes = PER_AGENT_SCOPES,
                limit = Limit.of(limit),
            ),
            limit,
        )
    }

    /** A server's global feed, attributed to the server rather than to whichever agent forwarded it. */
    fun findForServer(serverAddress: String, limit: Int, cursor: String?): ChatPageResponse {
        val (beforeAt, beforeId) = PageCursor.decode(cursor)
        return page(
            chatMessageRepository.pageForServer(
                beforeAt = beforeAt,
                beforeId = beforeId,
                serverAddress = serverAddress,
                scopes = SERVER_SCOPES,
                limit = Limit.of(limit),
            ),
            limit,
        )
    }

    @Scheduled(cron = PURGE_CRON)
    @Transactional
    fun purgeExpired() {
        val cutoff = Instant.now().minus(chatProperties.retention)
        val removed = chatMessageRepository.deleteOlderThan(cutoff)
        if (removed > 0) log.info("Purged {} chat messages older than {}", removed, cutoff)
    }

    private fun page(rows: List<ChatMessage>, limit: Int) = ChatPageResponse(
        items = rows.map { it.toResponse() },
        // A short page means the feed ran out. A full one may or may not have more, and one wasted
        // request at the end is cheaper than a count on every request.
        nextCursor = rows.lastOrNull()
            ?.takeIf { rows.size == limit }
            ?.let { PageCursor.encode(it.at, checkNotNull(it.id)) },
    )

    private companion object {
        val PER_AGENT_SCOPES = listOf(ChatScope.OUTBOUND, ChatScope.DIRECT, ChatScope.LOCAL)
        val SERVER_SCOPES = listOf(ChatScope.GLOBAL)

        /** 03:40 daily, ten minutes behind the audit purge so the two do not contend. */
        const val PURGE_CRON = "0 40 3 * * *"
    }
}

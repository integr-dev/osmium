package net.integr.osmium.chat.repository

import net.integr.osmium.chat.model.ChatMessage
import net.integr.osmium.chat.model.ChatScope
import org.springframework.data.domain.Limit
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant

interface ChatMessageRepository : JpaRepository<ChatMessage, Long> {

    /**
     * One agent's conversation, newest first, starting strictly before `(beforeAt, beforeId)`.
     *
     * The scopes are a parameter rather than a literal so the exclusion of
     * [ChatScope.GLOBAL] is decided where it is explained, in the service, instead of being an
     * enum constant buried in a query string.
     */
    @Query(
        """
        select m from ChatMessage m
        where (m.at < :beforeAt or (m.at = :beforeAt and m.id < :beforeId))
          and m.agentId = :agentId
          and m.scope in :scopes
        order by m.at desc, m.id desc
        """,
    )
    fun pageForAgent(
        @Param("beforeAt") beforeAt: Instant,
        @Param("beforeId") beforeId: Long,
        @Param("agentId") agentId: Long,
        @Param("scopes") scopes: Collection<ChatScope>,
        limit: Limit,
    ): List<ChatMessage>

    /**
     * A server's feed: everything the fleet heard or said there, global chat included. Scoped by
     * address rather than by agent, so it survives the agent that forwarded a line.
     */
    @Query(
        """
        select m from ChatMessage m
        where (m.at < :beforeAt or (m.at = :beforeAt and m.id < :beforeId))
          and m.serverAddress = :serverAddress
          and m.scope in :scopes
        order by m.at desc, m.id desc
        """,
    )
    fun pageForServer(
        @Param("beforeAt") beforeAt: Instant,
        @Param("beforeId") beforeId: Long,
        @Param("serverAddress") serverAddress: String,
        @Param("scopes") scopes: Collection<ChatScope>,
        limit: Limit,
    ): List<ChatMessage>

    @Modifying
    @Query("delete from ChatMessage m where m.at < :cutoff")
    fun deleteOlderThan(@Param("cutoff") cutoff: Instant): Int
}

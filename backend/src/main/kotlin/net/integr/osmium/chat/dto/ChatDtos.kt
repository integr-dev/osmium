package net.integr.osmium.chat.dto

import io.swagger.v3.oas.annotations.media.Schema
import net.integr.osmium.chat.model.ChatMessage
import net.integr.osmium.chat.model.ChatScope
import java.time.Instant

@Schema(description = "One line of Minecraft chat, as the agent that observed it reported it.")
data class ChatMessageResponse(
    val id: Long,
    @param:Schema(description = "When Osmium received it, not when the host observed it.")
    val at: Instant,
    @param:Schema(description = "The agent that observed it. Null once that agent has been deleted.")
    val agentId: Long?,
    @param:Schema(description = "The agent's label at the time, so the feed still reads after a deletion.")
    val agentLabel: String,
    val serverAddress: String,
    val scope: ChatScope,
    @param:Schema(description = "Who said it in game.", example = "Notch")
    val from: String,
    val text: String,
)

@Schema(description = "One page of chat, newest first.")
data class ChatPageResponse(
    val items: List<ChatMessageResponse>,
    @param:Schema(
        description = "Pass back as `cursor` for the next, older page. Null when the feed ends.",
        example = "2026-08-10T09:14:22.481Z|417",
    )
    val nextCursor: String?,
)

fun ChatMessage.toResponse(): ChatMessageResponse = ChatMessageResponse(
    id = checkNotNull(id) { "Chat message has not been persisted yet" },
    at = at,
    agentId = agentId,
    agentLabel = agentLabel,
    serverAddress = serverAddress,
    scope = scope,
    from = sender,
    text = text,
)

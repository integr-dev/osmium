package net.integr.osmium.chat.dto

import io.swagger.v3.oas.annotations.media.Schema
import net.integr.osmium.chat.model.ChatMessage
import net.integr.osmium.chat.model.ChatScope
import tools.jackson.databind.ObjectMapper
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
    /**
     * The same line as a Minecraft chat component, or null when the host sent none.
     *
     * **A map rather than the stored string.** It is held as text in the database, which this
     * backend never interprets - but the response has to *be* an object, and the published schema
     * has to say so. Writing the string out raw did produce the right JSON, and left every generated
     * client typed to expect a string it would then have to parse: springdoc derives a schema from
     * the Kotlin property and cannot be talked out of it. Parsing here is a page of chat at a time,
     * and it makes the type, the wire and the schema agree.
     *
     * Always paired with [text], which carries the whole line in plain form - so an interface that
     * ignores this loses the colours and nothing else.
     */
    @param:Schema(description = "The line as a Minecraft chat component. Null when the host sent none; `text` is always the whole line.")
    val components: Map<String, Any?>?,
)

/**
 * A run of lines refused as repetition, on its way to whoever is watching that server.
 *
 * Not a [ChatMessageResponse] with a flag on it. Nothing here was said by anybody, it has no id
 * because no row exists, and giving it the shape of a message would put something in the transcript
 * that reads like something somebody typed.
 */
@Schema(description = "Lines dropped in a row as repetition. Live only; never stored, never paged.")
data class ChatSuppressedResponse(
    @param:Schema(description = "When the most recent of them was refused.")
    val at: Instant,
    @param:Schema(description = "The server whose feed has the gap.")
    val serverAddress: String,
    @param:Schema(description = "Who was repeating themselves when the run started.", example = "Notch")
    val from: String,
    @param:Schema(description = "How many have been dropped since the last line that got through.")
    val count: Int,
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
    components = components?.let(::parseComponents),
)

/**
 * Reads a stored component tree back into a node.
 *
 * Its own mapper rather than the injected one, because this is a free function and the alternative
 * is threading a mapper through every call site that turns a row into a response. Nothing here is
 * configuration-sensitive: it reads JSON this backend itself wrote, having re-serialised a node that
 * had already parsed.
 *
 * A row that will not parse is served without its styling rather than failing the page. It should be
 * impossible - the column is only ever written from a parsed node - and a feed that returns nothing
 * because one old row is malformed would be a worse answer than one line drawn plain.
 */
private val componentReader = ObjectMapper()

@Suppress("UNCHECKED_CAST")
private fun parseComponents(stored: String): Map<String, Any?>? =
    runCatching { componentReader.readValue(stored, Map::class.java) as Map<String, Any?> }.getOrNull()

package net.integr.osmium.chat.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.chat.dto.ChatPageResponse
import net.integr.osmium.chat.service.ChatService
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/**
 * One endpoint, filtered two ways, because it is one feed read from two angles rather than two
 * resources. Which angle is not optional: an unfiltered firehose across every server is not
 * something any view wants.
 */
@RestController
@RequestMapping("/api/chat")
@Tag(name = "Chat", description = "What was said in game. Operator actions are the audit log, not this.")
class ChatController(private val chatService: ChatService) {

    @GetMapping
    @PreAuthorize("hasAuthority('chat.read')")
    @Operation(
        summary = "One page of chat, newest first.",
        description = """
            Pass exactly one of `agentId` or `server`.

            `agentId` gives the conversation to or about that agent, and excludes the global
            channel: that is identical for every agent on the server and would bury the lines that
            are actually about the one you are looking at.

            `server` gives everything that happened there - the global channel forwarded once by the
            elected listener, plus whispers, proximity chat and the agents' own outbound lines. Not
            the mirror of the above: a whisper to one agent is still something that happened on that
            server.

            `query` searches the message text and the sender, case-insensitively, and narrows
            whichever of the two filters was given. With neither, it searches every server the fleet
            was listening to - a phrase somebody half-remembers rarely comes with the server it was
            said on.

            Pages by cursor, not by offset: chat arrives while it is being read. Send `nextCursor`
            from the previous response to continue. Kept for 3 days.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "A page of chat."),
        ApiResponse(responseCode = "400", description = "Both filters given, neither given without a `query`, or a malformed `cursor`."),
        ApiResponse(responseCode = "403", description = "Missing node `chat.read`."),
    )
    fun list(
        @Parameter(description = "Conversation to or about this agent. Excludes the server's global chat.")
        @RequestParam(required = false) agentId: Long?,
        @Parameter(description = "Global chat on this server address.", example = "mc.example.com")
        @RequestParam(required = false) server: String?,
        @Parameter(
            description = "Search the text and the sender, case-insensitively. With neither " +
                "`agentId` nor `server`, searches every server the fleet was listening to.",
        )
        @RequestParam(required = false) query: String?,
        @Parameter(description = "How many lines to return. Clamped to 1..500.")
        @RequestParam(defaultValue = "100") limit: Int,
        @Parameter(description = "`nextCursor` from the previous page. Omit for the newest lines.")
        @RequestParam(required = false) cursor: String?,
    ): ChatPageResponse {
        val page = limit.coerceIn(MIN_LIMIT, MAX_LIMIT)
        val search = query?.trim()?.takeIf { it.isNotEmpty() }

        require(agentId == null || server == null) { "Pass at most one of agentId or server" }
        // Reading needs a scope; searching supplies its own. Every server at once is a firehose to
        // read and the whole point to search, which is the one asymmetry here.
        require(search != null || agentId != null || server != null) {
            "Pass exactly one of agentId or server, or a query to search"
        }

        return when {
            search == null && agentId != null ->
                chatService.findForAgent(agentId = agentId, limit = page, cursor = cursor)
            search == null ->
                chatService.findForServer(serverAddress = server!!, limit = page, cursor = cursor)
            agentId != null ->
                chatService.searchForAgent(agentId = agentId, query = search, limit = page, cursor = cursor)
            else ->
                chatService.search(serverAddress = server, query = search, limit = page, cursor = cursor)
        }
    }

    private companion object {
        const val MIN_LIMIT = 1
        const val MAX_LIMIT = 500
    }
}

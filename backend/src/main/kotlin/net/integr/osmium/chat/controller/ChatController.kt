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

            `agentId` gives the conversation to or about that agent. `server` gives what everyone on
            that server saw, forwarded once by the elected listener - deliberately separate, because
            the server's chat is identical for every agent on it and would otherwise bury the lines
            that are actually about the agent you are looking at.

            Pages by cursor, not by offset: chat arrives while it is being read. Send `nextCursor`
            from the previous response to continue. Kept for 3 days.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "A page of chat."),
        ApiResponse(responseCode = "400", description = "Neither or both filters given, or a malformed `cursor`."),
        ApiResponse(responseCode = "403", description = "Missing node `chat.read`."),
    )
    fun list(
        @Parameter(description = "Conversation to or about this agent. Excludes the server's global chat.")
        @RequestParam(required = false) agentId: Long?,
        @Parameter(description = "Global chat on this server address.", example = "mc.example.com:25565")
        @RequestParam(required = false) server: String?,
        @Parameter(description = "How many lines to return. Clamped to 1..500.")
        @RequestParam(defaultValue = "100") limit: Int,
        @Parameter(description = "`nextCursor` from the previous page. Omit for the newest lines.")
        @RequestParam(required = false) cursor: String?,
    ): ChatPageResponse {
        val page = limit.coerceIn(MIN_LIMIT, MAX_LIMIT)

        require((agentId == null) != (server == null)) {
            "Pass exactly one of agentId or server"
        }

        return if (agentId != null) {
            chatService.findForAgent(agentId = agentId, limit = page, cursor = cursor)
        } else {
            chatService.findForServer(serverAddress = server!!, limit = page, cursor = cursor)
        }
    }

    private companion object {
        const val MIN_LIMIT = 1
        const val MAX_LIMIT = 500
    }
}

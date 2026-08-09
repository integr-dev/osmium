package net.integr.osmium.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import net.integr.osmium.dto.BotResponse
import net.integr.osmium.dto.ChatRequest
import net.integr.osmium.dto.CreateBotRequest
import net.integr.osmium.dto.SetupBotRequest
import net.integr.osmium.dto.UpdateBotRequest
import net.integr.osmium.service.BotService
import org.springframework.http.HttpStatus
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/bots")
@Tag(name = "Bots", description = "Minecraft bots. Commands are routed to the host that runs them.")
class BotController(private val botService: BotService) {

    @GetMapping
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(summary = "List every bot.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "All bots."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
    )
    fun list(): List<BotResponse> = botService.findAll()

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(summary = "Read one bot.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The bot."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
        ApiResponse(responseCode = "404", description = "No such bot."),
    )
    fun get(@PathVariable id: Long): BotResponse = botService.findById(id)

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('agent.control')")
    @Operation(
        summary = "Create a bot slot.",
        description = "Nothing has touched Minecraft at this point; the bot starts UNLINKED.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "201", description = "Bot created."),
        ApiResponse(responseCode = "400", description = "Invalid fields, or unknown host."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.control`."),
        ApiResponse(responseCode = "409", description = "Label already in use."),
    )
    fun create(@Valid @RequestBody request: CreateBotRequest): BotResponse = botService.create(request)

    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('agent.control')")
    @Operation(
        summary = "Rename a bot or move it to another server.",
        description = "Omitted fields are left alone. Moving does not affect credentials - the " +
            "account is the same wherever it joins - but the bot must be offline first.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Updated bot."),
        ApiResponse(responseCode = "400", description = "Blank or over-long field."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.control`."),
        ApiResponse(responseCode = "404", description = "No such bot."),
        ApiResponse(responseCode = "409", description = "Label taken, or the bot is online."),
    )
    fun update(
        @PathVariable id: Long,
        @Valid @RequestBody request: UpdateBotRequest,
    ): BotResponse = botService.update(id, request)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('agent.control')")
    @Operation(summary = "Delete a bot.")
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Bot deleted."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.control`."),
        ApiResponse(responseCode = "404", description = "No such bot."),
    )
    fun delete(@PathVariable id: Long) = botService.delete(id)

    @PostMapping("/{id}/setup")
    @PreAuthorize("hasAuthority('agent.login')")
    @Operation(
        summary = "Ask the host to set this bot up.",
        description = "Sends `setup_bot` and moves the bot to SETUP_PENDING. Osmium does not " +
            "perform or observe the login - the host reports back a verdict.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted; bot is SETUP_PENDING."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.login`."),
        ApiResponse(responseCode = "404", description = "No such bot."),
        ApiResponse(responseCode = "409", description = "Setup already running, or the bot is online."),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun setup(
        @PathVariable id: Long,
        @Valid @RequestBody request: SetupBotRequest,
    ): BotResponse = botService.setup(id, request)

    @PostMapping("/{id}/connect")
    @PreAuthorize("hasAuthority('agent.control')")
    @Operation(summary = "Connect the bot to its Minecraft server.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.control`."),
        ApiResponse(responseCode = "404", description = "No such bot."),
        ApiResponse(responseCode = "409", description = "The bot has not been set up."),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun connect(@PathVariable id: Long): BotResponse = botService.connect(id)

    @PostMapping("/{id}/disconnect")
    @PreAuthorize("hasAuthority('agent.control')")
    @Operation(summary = "Disconnect the bot from its Minecraft server.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.control`."),
        ApiResponse(responseCode = "404", description = "No such bot."),
        ApiResponse(responseCode = "409", description = "The bot is not online."),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun disconnect(@PathVariable id: Long): BotResponse = botService.disconnect(id)

    @PostMapping("/{id}/chat")
    @PreAuthorize("hasAuthority('agent.chat')")
    @Operation(
        summary = "Speak in game as this bot.",
        description = "Impersonation: this says something under an account you own, so it is gated " +
            "separately from agent.control.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted."),
        ApiResponse(responseCode = "400", description = "Blank or over-long message."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.chat`."),
        ApiResponse(responseCode = "404", description = "No such bot."),
        ApiResponse(responseCode = "409", description = "The bot is not online."),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun chat(@PathVariable id: Long, @Valid @RequestBody request: ChatRequest): BotResponse =
        botService.chat(id, request)
}

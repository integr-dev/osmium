package net.integr.osmium.agent.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import net.integr.osmium.agent.dto.AgentResponse
import net.integr.osmium.agent.dto.AssignServerRequest
import net.integr.osmium.agent.dto.ChatRequest
import net.integr.osmium.agent.dto.CreateAgentRequest
import net.integr.osmium.agent.dto.SetupAgentRequest
import net.integr.osmium.agent.dto.UpdateAgentRequest
import net.integr.osmium.agent.service.AgentService
import org.springframework.http.HttpStatus
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import net.integr.osmium.agent.model.Agent

@RestController
@RequestMapping("/api/agents")
@Tag(name = "Agents", description = "Minecraft agents. Commands are routed to the host that runs them.")
class AgentController(private val agentService: AgentService) {

    @GetMapping
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(summary = "List every agent.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "All agents."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
    )
    fun list(): List<AgentResponse> = agentService.findAll()

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(summary = "Read one agent.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The agent."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
    )
    fun get(@PathVariable id: Long): AgentResponse = agentService.findById(id)

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasAuthority('agent.write')")
    @Operation(
        summary = "Create an agent slot.",
        description = "Nothing has touched Minecraft at this point; the agent starts UNLINKED.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "201", description = "Agent created."),
        ApiResponse(responseCode = "400", description = "Invalid fields, or unknown host."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.write`."),
        ApiResponse(responseCode = "409", description = "Label already in use."),
    )
    fun create(@Valid @RequestBody request: CreateAgentRequest): AgentResponse = agentService.create(request)

    @PatchMapping("/{id}")
    @PreAuthorize("hasAuthority('agent.write')")
    @Operation(
        summary = "Rename an agent.",
        description = "Omitted fields are left alone. Where an agent plays is set through " +
            "`PUT /api/agents/{id}/server`, which has its own preconditions.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Updated agent."),
        ApiResponse(responseCode = "400", description = "Blank or over-long field."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.write`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
        ApiResponse(responseCode = "409", description = "Label already taken."),
    )
    fun update(
        @PathVariable id: Long,
        @Valid @RequestBody request: UpdateAgentRequest,
    ): AgentResponse = agentService.update(id, request)

    /**
     * `agent.write`, not `agent.setup`: this is configuration, and no credential is
     * involved.
     * Which server an agent plays on is separable from setting it up precisely because the account
     * is the same account wherever it joins.
     */
    @PutMapping("/{id}/server")
    @PreAuthorize("hasAuthority('agent.write')")
    @Operation(
        summary = "Point the agent at a Minecraft server, or at none.",
        description = "Null unassigns it, leaving it set up and idle. Offline only: this decides " +
            "what the next connection targets, and changing it under a live session would describe " +
            "a session that is not happening. Credentials are untouched either way.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Updated agent."),
        ApiResponse(responseCode = "400", description = "Over-long address."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.write`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
        ApiResponse(responseCode = "409", description = "The agent is online."),
    )
    fun assignServer(
        @PathVariable id: Long,
        @Valid @RequestBody request: AssignServerRequest,
    ): AgentResponse = agentService.assignServer(id, request)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('agent.delete')")
    @Operation(summary = "Delete an agent.")
    @ApiResponses(
        ApiResponse(responseCode = "204", description = "Agent deleted."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.delete`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
    )
    fun delete(@PathVariable id: Long) = agentService.delete(id)

    @PostMapping("/{id}/setup")
    @PreAuthorize("hasAuthority('agent.setup')")
    @Operation(
        summary = "Ask the host to set this agent up.",
        description = "Sends `setup_agent` and moves the agent to SETUP_PENDING. Osmium does not " +
            "perform or observe the login - the host reports back a verdict.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted; agent is SETUP_PENDING."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.setup`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
        ApiResponse(responseCode = "409", description = "Setup already running, or the agent is online."),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun setup(
        @PathVariable id: Long,
        @Valid @RequestBody request: SetupAgentRequest,
    ): AgentResponse = agentService.setup(id, request)

    @PostMapping("/{id}/connect")
    @PreAuthorize("hasAuthority('agent.run')")
    @Operation(summary = "Connect the agent to its Minecraft server.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.run`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
        ApiResponse(
            responseCode = "409",
            description = "The agent has not been set up, or is assigned to no server.",
        ),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun connect(@PathVariable id: Long): AgentResponse = agentService.connect(id)

    @PostMapping("/{id}/disconnect")
    @PreAuthorize("hasAuthority('agent.run')")
    @Operation(summary = "Disconnect the agent from its Minecraft server.")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.run`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
        ApiResponse(responseCode = "409", description = "The agent is not online."),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun disconnect(@PathVariable id: Long): AgentResponse = agentService.disconnect(id)

    @PostMapping("/{id}/chat")
    @PreAuthorize("hasAuthority('chat.speak')")
    @Operation(
        summary = "Speak in game as this agent.",
        description = "Impersonation: this says something under an account you own, so it is gated " +
            "separately from every other verb. Rate limited per agent, because chat spam is the " +
            "fastest route to a Minecraft ban and the ban lands on the account, not the operator.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Command accepted."),
        ApiResponse(responseCode = "400", description = "Blank or over-long message."),
        ApiResponse(responseCode = "403", description = "Missing node `chat.speak`."),
        ApiResponse(responseCode = "404", description = "No such agent."),
        ApiResponse(responseCode = "409", description = "The agent is not online."),
        ApiResponse(responseCode = "429", description = "This agent has been made to speak too often."),
        ApiResponse(responseCode = "503", description = "The owning host is not connected."),
    )
    fun chat(@PathVariable id: Long, @Valid @RequestBody request: ChatRequest): AgentResponse =
        agentService.chat(id, request)
}

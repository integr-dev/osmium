package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentResponse
import net.integr.osmium.agent.dto.ChatRequest
import net.integr.osmium.agent.dto.CreateAgentRequest
import net.integr.osmium.agent.dto.SetupAgentRequest
import net.integr.osmium.agent.dto.UpdateAgentRequest
import net.integr.osmium.agent.dto.toResponse
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.host.repository.HostRepository
import net.integr.osmium.liveupdates.FleetEvent
import net.integr.osmium.liveupdates.FleetEventBroker
import net.integr.osmium.liveupdates.FleetEventType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.MessageKind
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.util.UUID
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.host.model.Host

@Service
@Transactional(readOnly = true)
class AgentService(
    private val agentRepository: AgentRepository,
    private val hostRepository: HostRepository,
    private val registry: HostConnections,
    private val objectMapper: ObjectMapper,
    private val auditService: AuditService,
    private val broker: FleetEventBroker,
) {
    fun findAll(): List<AgentResponse> =
        agentRepository.findAll().sortedBy { it.label }.map { it.toResponse() }

    fun findById(id: Long): AgentResponse = require(id).toResponse()

    @Transactional
    fun create(request: CreateAgentRequest): AgentResponse {
        check(!agentRepository.existsByLabel(request.label)) {
            "Agent '${request.label}' already exists"
        }
        val host = hostRepository.findById(request.hostId)
            .orElseThrow { IllegalArgumentException("No host with id ${request.hostId}") }

        val agent = Agent(
            label = request.label,
            host = host,
            serverAddress = normalizeServer(request.serverAddress),
            state = AgentState.UNLINKED,
        )
        val saved = agentRepository.save(agent)
        auditService.record(
            action = AuditAction.AGENT_CREATE,
            target = saved.label,
            detail = "On ${host.name}, for ${saved.serverAddress}",
        )
        publish(saved)
        return saved.toResponse()
    }

    /**
     * Renames an agent and/or moves it to another Minecraft server.
     *
     * A move leaves credentials untouched: the account is the same account whichever server it
     * joins. It does require the agent to be offline, because the server address is what the next
     * connection targets, and an agent is one session on one server.
     */
    @Transactional
    fun update(id: Long, request: UpdateAgentRequest): AgentResponse {
        val agent = require(id)
        val changes = mutableListOf<String>()

        request.label?.let { label ->
            require(label.isNotBlank()) { "Label must not be blank" }
            if (label != agent.label) {
                check(!agentRepository.existsByLabel(label)) { "Agent '$label' already exists" }
                changes += "renamed from ${agent.label}"
                agent.label = label
            }
        }

        request.serverAddress?.let { address ->
            require(address.isNotBlank()) { "Server address must not be blank" }
            val moved = normalizeServer(address)
            if (moved != agent.serverAddress) {
                check(agent.state != AgentState.ONLINE) {
                    "Disconnect '${agent.label}' before moving it to another server"
                }
                changes += "moved from ${agent.serverAddress} to $moved"
                agent.serverAddress = moved
            }
        }

        // A request that changes nothing records nothing: an entry saying an agent was edited into
        // exactly its previous shape is noise, and the endpoint accepts no-op patches.
        if (changes.isNotEmpty()) {
            auditService.record(
                action = AuditAction.AGENT_UPDATE,
                target = agent.label,
                detail = changes.joinToString("; "),
            )
            publish(agent)
        }

        return agent.toResponse()
    }

    @Transactional
    fun delete(id: Long) {
        val agent = require(id)
        // Read the label before the delete: it is the only thing that makes the entry legible after.
        val label = agent.label
        val hostName = agent.host.name

        agentRepository.delete(agent)
        auditService.record(
            action = AuditAction.AGENT_DELETE,
            target = label,
            detail = "Was on $hostName; credentials cached there are not removed by this",
        )
        broker.publish(
            FleetEvent(type = FleetEventType.AGENT_REMOVED, data = mapOf("id" to id), agentId = id),
        )
    }

    /**
     * Asks the host to set the agent up. The backend does not perform or observe the login - it sends
     * the command and waits for the host's verdict, which is why this only moves the agent to
     * SETUP_PENDING. See FLEET_CONNECTIVITY.md, Phase 2.
     */
    @Transactional
    fun setup(id: Long, request: SetupAgentRequest): AgentResponse {
        val agent = require(id)
        check(agent.state != AgentState.SETUP_PENDING) { "Setup for '${agent.label}' is already in progress" }
        check(agent.state != AgentState.ONLINE) { "Disconnect '${agent.label}' before setting it up again" }

        // The method is a mechanism selector the operator chose, relayed uninterpreted. It must
        // never carry an account hint - see the wire protocol section of FLEET_CONNECTIVITY.md.
        dispatch(
            agent = agent,
            type = CommandType.SETUP_AGENT,
            payload = mapOf(
                "label" to agent.label,
                "serverAddress" to agent.serverAddress,
                "method" to request.method,
            ),
        )
        agent.state = AgentState.SETUP_PENDING
        // The mechanism is recorded; the credential it produces is never seen here to record.
        auditService.record(
            action = AuditAction.AGENT_SETUP,
            target = agent.label,
            detail = "Method '${request.method}' on ${agent.host.name}",
        )
        publish(agent)
        return agent.toResponse()
    }

    @Transactional
    fun connect(id: Long): AgentResponse {
        val agent = require(id)
        check(agent.state in CONNECTABLE) {
            "'${agent.label}' cannot connect from ${agent.state}; it must be set up first"
        }
        dispatch(agent, CommandType.CONNECT, mapOf("serverAddress" to agent.serverAddress))
        auditService.record(
            action = AuditAction.AGENT_CONNECT,
            target = agent.label,
            detail = agent.serverAddress,
        )
        return agent.toResponse()
    }

    @Transactional
    fun disconnect(id: Long): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }
        dispatch(agent, CommandType.DISCONNECT)
        auditService.record(
            action = AuditAction.AGENT_DISCONNECT,
            target = agent.label,
            detail = agent.serverAddress,
        )
        return agent.toResponse()
    }

    @Transactional
    fun chat(id: Long, request: ChatRequest): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }
        dispatch(agent, CommandType.CHAT, mapOf("message" to request.message))
        // The text is the point: recording that an operator made an agent speak without recording
        // what it said is close to useless. See the Audit section of FLEET_CONNECTIVITY.md.
        auditService.record(
            action = AuditAction.AGENT_CHAT,
            target = agent.label,
            detail = request.message,
        )
        return agent.toResponse()
    }

    /**
     * Sends one command to the host that owns this agent, and fails immediately if there is no live
     * host to take it. Commands are never queued: one firing long after an operator has resolved
     * things by hand is worse than an outright failure.
     *
     * Fire and forget by design. The host is the source of truth about its agents, so state advances
     * when it reports back, not when the command is accepted here.
     */
    private fun dispatch(agent: Agent, type: String, payload: Map<String, Any?> = emptyMap()) {
        val hostId = checkNotNull(agent.host.id) { "Host has not been persisted yet" }

        val envelope = HostEnvelope(
            id = "cmd-${UUID.randomUUID()}",
            kind = MessageKind.COMMAND,
            type = type,
            agentId = agent.id,
            payload = objectMapper.valueToTree(payload),
        )
        if (!registry.send(hostId, envelope)) throw HostUnreachableException(agent.host.name)
    }

    private fun require(id: Long): Agent =
        agentRepository.findById(id).orElseThrow { NoSuchElementException("No agent with id $id") }

    /**
     * Connect, disconnect and chat publish nothing on purpose: they are fire-and-forget commands
     * that change no stored state. The state advances when the host reports back, and that report
     * is what the browser is told about.
     */
    private fun publish(agent: Agent) = broker.publish(
        FleetEvent(type = FleetEventType.AGENT_CHANGED, data = agent.toResponse(), agentId = agent.id),
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
        val CONNECTABLE = setOf(AgentState.LINKED, AgentState.CONNECT_FAILED, AgentState.STALE)
        const val DEFAULT_PORT = 25565
    }
}

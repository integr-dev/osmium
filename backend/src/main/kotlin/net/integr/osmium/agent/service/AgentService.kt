package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentResponse
import net.integr.osmium.agent.dto.ChatRequest
import net.integr.osmium.agent.dto.AssignServerRequest
import net.integr.osmium.agent.dto.CreateAgentRequest
import net.integr.osmium.agent.dto.SetupAgentRequest
import net.integr.osmium.agent.dto.UpdateAgentRequest
import net.integr.osmium.agent.dto.toResponse
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.config.AgentProperties
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import net.integr.osmium.activity.service.ActivityService
import net.integr.osmium.build.service.BuildJobService
import net.integr.osmium.chat.service.ChatRateLimiter
import net.integr.osmium.host.repository.HostRepository
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.MessageKind
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.time.Instant
import java.util.UUID
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.host.model.Host

@Service
@Transactional(readOnly = true)
class AgentService(
    private val agentRepository: AgentRepository,
    private val hostRepository: HostRepository,
    private val registry: HostConnections,
    private val chatRateLimiter: ChatRateLimiter,
    private val telemetryStore: AgentTelemetryStore,
    private val telemetryPublisher: AgentTelemetryPublisher,
    private val objectMapper: ObjectMapper,
    private val auditService: AuditService,
    private val broker: LiveUpdateBroker,
    private val activityService: ActivityService,
    private val buildJobs: BuildJobService,
    private val properties: AgentProperties,
) {
    fun findAll(): List<AgentResponse> =
        agentRepository.findAll().sortedBy { it.label }.map { it.toResponse(telemetryStore.find(it.id)) }

    fun findById(id: Long): AgentResponse = require(id).let { it.toResponse(telemetryStore.find(it.id)) }

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
            serverAddress = request.serverAddress?.takeIf { it.isNotBlank() }?.let(::normalizeServer),
            state = AgentState.UNLINKED,
        )
        val saved = agentRepository.save(agent)
        auditService.record(
            action = AuditAction.AGENT_CREATE,
            target = saved.label,
            detail = "On ${host.name}, for ${saved.serverAddress ?: "no server yet"}",
        )
        publish(saved)
        return saved.toResponse(telemetryStore.find(saved.id))
    }

    /**
     * Points an agent at a Minecraft server, or at none.
     *
     * Its own operation rather than a field on the edit, because it is a different kind of change:
     * a rename is cosmetic and can happen at any time, while where an agent plays decides what the
     * next connection targets. Offline only, for that reason — an agent is one session on one
     * server, and moving the target under a live one would describe a session that is not happening.
     *
     * Credentials are untouched either way. The account is the same account wherever it joins,
     * which is the whole reason this is separable from setup.
     */
    @Transactional
    fun assignServer(id: Long, request: AssignServerRequest): AgentResponse {
        val agent = require(id)
        val target = request.serverAddress?.takeIf { it.isNotBlank() }?.let(::normalizeServer)
        if (target == agent.serverAddress) return agent.toResponse(telemetryStore.find(agent.id))

        check(agent.state != AgentState.ONLINE) {
            "Disconnect '${agent.label}' before changing the server it plays on"
        }

        val previous = agent.serverAddress
        agent.serverAddress = target
        auditService.record(
            action = AuditAction.AGENT_UPDATE,
            target = agent.label,
            detail = when {
                target == null -> "unassigned from $previous"
                previous == null -> "assigned to $target"
                else -> "moved from $previous to $target"
            },
        )
        publish(agent)
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /**
     * Renames an agent.
     *
     * Where it plays is [assignServer]: that decides what the next connection targets and is only
     * allowed offline, where a rename is cosmetic and always allowed.
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

        return agent.toResponse(telemetryStore.find(agent.id))
    }

    @Transactional
    fun delete(id: Long) {
        val agent = require(id)
        // Read the label before the delete: it is the only thing that makes the entry legible after.
        val label = agent.label
        val hostName = agent.host.name

        // Before the delete, so the segments go back to the pool rather than being left assigned to
        // a null the foreign key put there. The alternative is a live segment nobody owns and no
        // interface can offer to reassign. Job membership goes with them.
        buildJobs.forget(agent)

        agentRepository.delete(agent)
        // Otherwise the limiter's map keeps a bucket per agent that has ever existed in this process.
        chatRateLimiter.forget(id)
        telemetryStore.forget(id)
        telemetryPublisher.forget(id)
        auditService.record(
            action = AuditAction.AGENT_DELETE,
            target = label,
            detail = "Was on $hostName; credentials cached there are not removed by this",
        )
        broker.publish(
            LiveUpdateEvent(type = LiveUpdateType.AGENT_REMOVED, data = mapOf("id" to id), agentId = id),
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
        //
        // Checked against what this host advertised on connect: membership in a list the host
        // itself supplied, rather than the backend knowing what a method means. Otherwise the
        // mistake costs a round trip and comes back as a setup_result refusal, having moved the
        // agent through SETUP_PENDING on the way.
        //
        // Only while it is connected. Disconnected, the empty list means nobody has said, not that
        // the method is wrong, and `dispatch` has the truthful answer for that: undeliverable.
        val hostId = agent.host.id!!
        if (registry.isConnected(hostId)) {
            val offered = registry.loginMethodsOf(hostId)
            require(offered.any { it.id == request.method }) {
                if (offered.isEmpty()) {
                    "'${agent.host.name}' has not said what it can log in with"
                } else {
                    "'${agent.host.name}' cannot log in with '${request.method}'"
                }
            }
        }

        dispatch(
            agent = agent,
            type = CommandType.SETUP_AGENT,
            // No server address. Setting an agent up is acquiring a credential, and a Minecraft
            // account can join any server — telling the host which one at this point would hand it
            // a value that goes stale the moment the agent is reassigned. `connect` carries it,
            // which is where it is actually needed. See host/README.md.
            payload = mapOf(
                "label" to agent.label,
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
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /**
     * Stops waiting on a setup that is never going to be answered.
     *
     * Setup is open-ended **by design** — the backend hands the login to the host and cannot see how
     * far along it is, so unlike a connect there is nothing here that can honestly time it out. That
     * left SETUP_PENDING as a dead end: an operator whose sign-in was never finished, because it was
     * started on the wrong machine or the device code expired, had a permanently pending agent whose
     * Set-up button was disabled precisely because a setup was in progress.
     *
     * **Nothing is sent to the host.** This is not "cancel the login", which the backend has no
     * standing to order and no way to perform; it is "stop asserting one is in progress". If the
     * host does complete it afterwards the result still arrives and still links the agent, because
     * [HostReportService] applies a setup result on its own merits rather than on the state it
     * expected to find.
     */
    @Transactional
    fun cancelSetup(id: Long): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.SETUP_PENDING) { "'${agent.label}' is not being set up" }

        // Where a failed setup lands, which is what this is being treated as: nothing came back.
        agent.state = AgentState.UNLINKED
        auditService.record(
            action = AuditAction.AGENT_SETUP_CANCEL,
            target = agent.label,
            detail = "Stopped waiting on ${agent.host.name}; no command was sent to it",
        )
        activityService.record(
            agent = agent,
            scope = ActivityScope.LIFECYCLE,
            severity = ActivitySeverity.INFO,
            text = "An operator stopped waiting on this setup; the host was not told to stop",
        )
        publish(agent)
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /**
     * Asks the host to bring the agent into game, and moves it to CONNECTING while that happens.
     *
     * The state is the point. Accepting the command takes milliseconds and joining a Minecraft
     * server takes seconds, and the outcome arrives on the host's own schedule as ONLINE or
     * CONNECT_FAILED. Without a state for the interval, the badge went on reading LINKED - the same
     * thing it read before the operator pressed anything.
     */
    @Transactional
    fun connect(id: Long): AgentResponse {
        val agent = require(id)
        // Named separately from the set below, because "it must be set up first" is a lie for an
        // agent that is already on its way in, and telling an operator to set up an agent that is
        // mid-connect sends them to a button that will refuse them too.
        check(agent.state != AgentState.CONNECTING) { "'${agent.label}' is already connecting" }
        check(agent.state in CONNECTABLE) {
            "'${agent.label}' cannot connect from ${agent.state}; it must be set up first"
        }
        // An agent assigned nowhere has nowhere to connect to. Refused here rather than sent to the
        // host with a blank address, which it could only fail on.
        val server = checkNotNull(agent.serverAddress) {
            "'${agent.label}' is not assigned to a server"
        }
        dispatch(agent, CommandType.CONNECT, mapOf("serverAddress" to server))
        agent.state = AgentState.CONNECTING
        agent.connectingSince = Instant.now()
        auditService.record(
            action = AuditAction.AGENT_CONNECT,
            target = agent.label,
            detail = server,
        )
        publish(agent)
        return agent.toResponse(telemetryStore.find(agent.id))
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
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    @Transactional
    fun chat(id: Long, request: ChatRequest): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }
        // Before dispatch: a refused message never reaches Minecraft, and because the audit entry
        // is written in the same transaction, it leaves no trace of having been said.
        chatRateLimiter.check(agentId = id, agentLabel = agent.label)
        try {
            dispatch(agent, CommandType.CHAT, mapOf("message" to request.message))
        } catch (failure: Exception) {
            // Nothing was said, so nothing is spent. The budget is not transactional, so an
            // undeliverable message would otherwise count against a limit it never reached - and an
            // operator retrying a dead host would talk themselves out of chatting once it returned.
            chatRateLimiter.refund(id)
            throw failure
        }
        // The text is the point: recording that an operator made an agent speak without recording
        // what it said is close to useless. See the Audit section of FLEET_CONNECTIVITY.md.
        auditService.record(
            action = AuditAction.AGENT_CHAT,
            target = agent.label,
            detail = request.message,
        )
        return agent.toResponse(telemetryStore.find(agent.id))
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
     * Gives up on a CONNECTING agent the host never answered for, and says so.
     *
     * Without this, CONNECTING would be a worse place to be stuck than LINKED ever was. Before the
     * state existed, a connect nobody answered left the agent at LINKED and the operator could
     * simply press the button again; a CONNECTING that never clears both refuses the retry and goes
     * on claiming something is happening. A pending state that cannot end is not a report, it is a
     * lie with a spinner on it.
     *
     * Back to LINKED rather than CONNECT_FAILED. The Minecraft server did not refuse anything -
     * nobody said anything at all - and inventing a refusal would put a red badge on an agent whose
     * only problem is a host that went quiet.
     */
    @Scheduled(fixedDelay = CONNECT_SWEEP_MS, initialDelay = CONNECT_SWEEP_MS)
    @Transactional
    fun abandonStalledConnects() {
        val cutoff = Instant.now().minus(properties.connectWindow)

        for (agent in agentRepository.findAllByState(AgentState.CONNECTING)) {
            // Null would be a row that reached CONNECTING without going through `connect`, which
            // nothing does. Left alone rather than expired on sight: there is no evidence it has
            // been waiting at all, and guessing would end a join that may have just started.
            val since = agent.connectingSince ?: continue
            if (since.isAfter(cutoff)) continue

            log.info("Host {} did not report on {} within the connect window", agent.host.name, agent.label)
            agent.state = AgentState.LINKED
            agent.connectingSince = null
            // The operator did not cause this and would otherwise watch the badge fall back with no
            // explanation, which is exactly what the activity feed is for.
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.WARNING,
                text = "The host did not say whether this agent got into the game, so it is no longer connecting",
            )
            publish(agent)
        }
    }

    /**
     * Disconnect and chat publish nothing on purpose: they are fire-and-forget commands that change
     * no stored state. The state advances when the host reports back, and that report is what the
     * browser is told about. Connect is the exception - it moves the agent to CONNECTING, which is
     * a stored change and therefore has to be announced like any other.
     */
    private fun publish(agent: Agent) = broker.publish(
        LiveUpdateEvent(type = LiveUpdateType.AGENT_CHANGED, data = agent.toResponse(telemetryStore.find(agent.id)), agentId = agent.id),
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
        val log: Logger = LoggerFactory.getLogger(AgentService::class.java)

        val CONNECTABLE = setOf(AgentState.LINKED, AgentState.CONNECT_FAILED, AgentState.STALE)
        const val DEFAULT_PORT = 25565

        /** Frequent enough that the badge falls back while the operator is still looking at it. */
        const val CONNECT_SWEEP_MS = 5_000L
    }
}

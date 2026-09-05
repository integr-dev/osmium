package net.integr.osmium.agent.service

import net.integr.osmium.agent.dto.AgentInventoryResponse
import net.integr.osmium.agent.dto.AgentPathResponse
import net.integr.osmium.agent.dto.PathToRequest
import net.integr.osmium.agent.dto.AgentResponse
import net.integr.osmium.agent.dto.AgentSettingsRequest
import net.integr.osmium.agent.dto.ChatRequest
import net.integr.osmium.agent.dto.AssignServerRequest
import net.integr.osmium.agent.dto.CreateAgentRequest
import net.integr.osmium.agent.dto.DropItemRequest
import net.integr.osmium.agent.dto.HoldItemRequest
import net.integr.osmium.agent.dto.MoveItemRequest
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
import java.time.Duration
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
    private val inventoryStore: AgentInventoryStore,
    private val pathStore: AgentPathStore,
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

        // Before the delete, while the agent still names a host to send it to. A host binds each
        // credential to the agent it was acquired for, so that a restart can rebuild its agents
        // rather than leaving them unreachable - and nothing else in the protocol ever reports that
        // an agent stopped existing, so without this it holds an account for something nobody can
        // use.
        //
        // Best effort on purpose: an unreachable host keeps the stale binding, and deleting an
        // agent must not be refused because a machine is switched off.
        runCatching { dispatch(agent, CommandType.DELETE_AGENT) }.onFailure {
            log.info("Could not tell {} that '{}' is gone: {}", hostName, label, it.message)
        }

        agentRepository.delete(agent)
        // Otherwise the limiter's map keeps a bucket per agent that has ever existed in this process.
        chatRateLimiter.forget(id)
        telemetryStore.forget(id)
        telemetryPublisher.forget(id)
        inventoryStore.forget(id)
        pathStore.forget(id)
        auditService.record(
            action = AuditAction.AGENT_DELETE,
            target = label,
            detail = "Was on $hostName; it is told to release the agent, but the account is kept there",
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
        // Somebody has now said where this agent belongs, which is the whole of what `wanted` means.
        // Set whether or not `connect.rejoin` is on: the setting decides whether the wish is acted
        // on later, and an operator who turns it on mid-outage should not have to press Connect once
        // more just to record a preference they have already expressed.
        agent.wanted = true
        // A fresh start, so the next drop waits the shortest delay rather than inheriting the
        // patience of whatever went wrong last time.
        agent.rejoinAttempts = 0
        agent.rejoinAt = null
        auditService.record(
            action = AuditAction.AGENT_CONNECT,
            target = agent.label,
            detail = server,
        )
        publish(agent)
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /**
     * Records that an agent took itself out of the game and is to be left there.
     *
     * **The one thing a host may decide about where an agent belongs.** Everywhere else that rule
     * holds absolutely - a host reports, the backend decides - and it is bent here for a reason the
     * rule cannot serve: the agent is the only thing that can see who is standing next to it, and
     * the sweep would put it straight back beside them.
     *
     * No audit entry. The audit trail is who did what, and nobody did this; the host raises an
     * activity entry, which is where something that happened *to* an agent belongs.
     */
    @Transactional
    fun standDown(agent: Agent, reason: String?) {
        log.info("Agent {} stood itself down: {}", agent.label, reason ?: "no reason given")

        if (!agent.wanted && agent.rejoinAt == null && agent.rejoinAttempts == 0) return

        agent.wanted = false
        agent.rejoinAttempts = 0
        agent.rejoinAt = null
        agentRepository.save(agent)

        broker.publish(
            LiveUpdateEvent(
                type = LiveUpdateType.AGENT_CHANGED,
                data = agent.toResponse(telemetryStore.find(agent.id)),
                agentId = agent.id,
            ),
        )
    }

    /**
     * Stops an agent going to, or staying at, its server.
     *
     * **Three situations, one button.** It can be in the game, on its way in, or sitting out a
     * backoff before the next attempt - and an operator who has just watched an agent be banned
     * wants the same thing in all three: stop. Allowing only ONLINE left the other two with no way
     * out except waiting for the attempts to run down.
     */
    @Transactional
    fun disconnect(id: Long): AgentResponse {
        val agent = require(id)

        val inGame = agent.state == AgentState.ONLINE
        val arriving = agent.state == AgentState.CONNECTING
        check(inGame || arriving || agent.wanted) {
            "'${agent.label}' is not connected and is not trying to be"
        }

        // Only when there is a session to end or an attempt in flight. A rejoin waiting out a
        // backoff is bookkeeping on this side alone, and refusing to cancel it because the host is
        // unreachable would strand the intent at the moment an operator most wants it gone.
        if (inGame || arriving) dispatch(agent, CommandType.DISCONNECT)

        // An operator taking an agent out of the game means it, so it stays out. Without this the
        // rejoin sweep would read the resulting LINKED as a drop and put it straight back in, and
        // the Disconnect button would appear not to work.
        agent.wanted = false
        agent.rejoinAttempts = 0
        agent.rejoinAt = null
        auditService.record(
            action = AuditAction.AGENT_DISCONNECT,
            target = agent.label,
            detail = agent.serverAddress,
        )

        /*
         * **Said out loud, like every other change to an agent.** This was the one mutation that
         * only answered its caller, and for an agent in the game it looked fine: the host reports
         * having left a moment later, and that report publishes.
         *
         * There is no host round trip for the third case. Cancelling a rejoin that is waiting out a
         * backoff sends nothing and is over the instant it is asked for - so nothing published,
         * every open page went on showing an agent that was still trying, and the button offering
         * to stop it stayed live over a backend that would answer "it is not trying to be".
         */
        publish(agent)
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /**
     * Stores what an operator configured for one agent, and tells its host.
     *
     * **Stored whether or not the host is reachable.** Configuration is a stated preference, not an
     * action: refusing to save it because a machine is switched off would lose the operator's work
     * over something they cannot see and did not cause. It is relayed on the next reconnect, which
     * is the same handshake that already re-establishes everything else.
     *
     * The keys are the interface's, and this reads exactly one of them - `connect.rejoin`, which
     * asks for something a host is not allowed to decide. See [Agent.settings] and [rejoins].
     */
    @Transactional
    fun configure(id: Long, request: AgentSettingsRequest): AgentResponse {
        val agent = require(id)
        val values = request.values.orEmpty()

        val encoded = objectMapper.writeValueAsString(values)
        check(encoded.length <= Agent.SETTINGS_MAX) {
            "That is more configuration than '${agent.label}' can hold"
        }

        agent.settings = encoded

        // Best effort, and deliberately after the store. An unreachable host gets it on reconnect;
        // an operator who has to keep the page open until a machine comes back has been given a
        // worse tool than one that simply remembers.
        runCatching { dispatch(agent, CommandType.SETTINGS, mapOf("values" to values)) }
            .onFailure { log.debug("Stored settings for '{}' but its host did not take them", agent.label) }

        auditService.record(
            action = AuditAction.AGENT_UPDATE,
            target = agent.label,
            detail = if (values.isEmpty()) "configuration cleared" else "configured ${values.keys.sorted().joinToString(", ")}",
        )
        publish(agent)
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
     * What the agent is carrying, or null when it has not reported recently enough to trust.
     *
     * Read straight out of the store rather than asked for. An inventory arrives whenever items
     * move and is already there by the time anybody opens the page, which is the same bargain the
     * map makes - and there is no command that means "tell me again", because a host that would
     * answer one is a host that has already sent it.
     */
    fun inventory(id: Long): AgentInventoryResponse? {
        val agent = require(id)
        return inventoryStore.find(agent.id)
    }

    /**
     * Moves what an agent is carrying from one square to another.
     *
     * Online only: this is a click in a window that only exists while the agent is in the game.
     * Nothing is echoed back and the stored inventory is left alone - the host reports where the
     * item ended up, and reporting it here first would show the move as done before the server had
     * agreed to it.
     */
    @Transactional
    fun moveItem(id: Long, request: MoveItemRequest): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }

        dispatch(
            agent,
            CommandType.INVENTORY_MOVE,
            mapOf("from" to request.from, "to" to request.to),
        )
        auditService.record(
            action = AuditAction.AGENT_INVENTORY,
            target = agent.label,
            // The squares, because that is all this knows. What was in them is the host's to say,
            // and asking would make an audit line depend on a reading that may already be stale.
            detail = "moved slot ${request.from} to ${request.to}",
        )
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /** Throws what is in a square on the ground. Online only, for the same reason as [moveItem]. */
    @Transactional
    fun dropItem(id: Long, request: DropItemRequest): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }

        dispatch(
            agent,
            CommandType.INVENTORY_DROP,
            // Omitted rather than sent as null when the whole stack goes, which is what the host
            // reads an absent count as.
            mapOf("slot" to request.slot) + (request.count?.let { mapOf("count" to it) } ?: emptyMap()),
        )
        auditService.record(
            action = AuditAction.AGENT_INVENTORY,
            target = agent.label,
            detail = "dropped ${request.count?.toString() ?: "everything"} from slot ${request.slot}",
        )
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /** Puts a hotbar square in the agent's hand. Online only, for the same reason as [moveItem]. */
    @Transactional
    fun holdItem(id: Long, request: HoldItemRequest): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }

        dispatch(agent, CommandType.INVENTORY_HOLD, mapOf("slot" to request.slot))
        auditService.record(
            action = AuditAction.AGENT_INVENTORY,
            target = agent.label,
            detail = "held slot ${request.slot}",
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
    /**
     * Every journey in progress, for a screen that has just been opened.
     *
     * Read straight out of the store rather than asked for, the same bargain the inventory makes.
     * A path is reported while it is being walked, so it is already there by the time anybody looks
     * - and there is no command that means "tell me again", because a host that would answer one is
     * a host that has already sent it.
     */
    fun paths(): List<AgentPathResponse> = pathStore.all()

    /**
     * Sends an agent somewhere.
     *
     * Online only: a route is about the world the agent is standing in, and one held for a session
     * that has not started would be walked in whichever world it eventually joins.
     *
     * **Nothing is echoed back.** The path does not exist yet - only the host can see the blocks, so
     * it plans and then says what it found. Recording a journey here first would draw a straight
     * line to the destination and then replace it with the real one, which reads as the agent
     * changing its mind about a route it never had.
     */
    @Transactional
    fun pathTo(id: Long, request: PathToRequest): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }

        dispatch(
            agent,
            CommandType.PATH_TO,
            // The height only when there is one. An absent `y` is what tells the host to aim at the
            // column rather than the point, and sending a null would be a number it has to interpret.
            mapOf(
                "waypoints" to request.waypoints.map { point ->
                    buildMap {
                        put("x", point.x)
                        point.y?.let { put("y", it) }
                        put("z", point.z)
                    }
                },
            ),
        )

        val destination = request.waypoints.last()
        auditService.record(
            action = AuditAction.AGENT_PATH,
            target = agent.label,
            // The destination, and how many hops were asked for. Not the path: that is planned on
            // the host and is not what the operator decided.
            detail = "sent to ${destination.x.toInt()} ${destination.y?.toInt() ?: "any"} ${destination.z.toInt()}" +
                if (request.waypoints.size > 1) " by way of ${request.waypoints.size - 1} waypoint(s)" else "",
        )
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    /**
     * Stops an agent where it is.
     *
     * Not refused for one that is going nowhere, and not refused while it is building: stopping is
     * what an operator presses when they have seen enough, and the one command that undoes a
     * journey must not be the one that is unavailable. Online only, because there is nobody to tell
     * otherwise.
     */
    @Transactional
    fun pathStop(id: Long): AgentResponse {
        val agent = require(id)
        check(agent.state == AgentState.ONLINE) { "'${agent.label}' is not online" }

        dispatch(agent, CommandType.PATH_STOP)
        auditService.record(
            action = AuditAction.AGENT_PATH,
            target = agent.label,
            detail = "told to stop where it is",
        )
        return agent.toResponse(telemetryStore.find(agent.id))
    }

    private fun dispatch(agent: Agent, type: String, payload: Map<String, Any?> = emptyMap()) {
        refuseIfBuilding(agent, type)
        if (!offer(agent, type, payload)) throw HostUnreachableException(agent.host.name)
    }

    /**
     * Stops a command that would corrupt a build the agent is in the middle of.
     *
     * **Here, in the one funnel every command goes through**, rather than at each call site. A guard
     * on the three verbs that need it today is a guard somebody forgets on the fourth, and the
     * failure mode is silent: the command works, the build comes out wrong, and nothing connects
     * the two. Put here, a new command is refused or allowed because [CommandType.DISRUPTS_BUILDING]
     * says so, and a command that is in neither set fails a test rather than shipping unclassified.
     *
     * Holding a segment is the condition, not "the job is running": a job with work left but
     * nothing assigned to this agent is a job this agent is not in the middle of.
     */
    private fun refuseIfBuilding(agent: Agent, type: String) {
        if (type !in CommandType.DISRUPTS_BUILDING) return

        val agentId = agent.id ?: return
        val holding = buildJobs.segmentsHeldBy(agentId)
        check(holding.isEmpty()) {
            "'${agent.label}' is building ${holding.joinToString(", ")} and cannot be interrupted"
        }
    }

    /**
     * [dispatch] for a caller that would rather be told than thrown at.
     *
     * The rejoin sweep works through the whole fleet in one transaction, so a host that dropped
     * between the reachability check and the send must not take the other agents' bookkeeping down
     * with it - an exception there marks the transaction rollback-only, and every attempt counted so
     * far is undone. Everything an operator pressed still throws, which is what an operator is owed.
     */
    private fun offer(agent: Agent, type: String, payload: Map<String, Any?> = emptyMap()): Boolean {
        val hostId = checkNotNull(agent.host.id) { "Host has not been persisted yet" }

        val envelope = HostEnvelope(
            id = "cmd-${UUID.randomUUID()}",
            kind = MessageKind.COMMAND,
            type = type,
            agentId = agent.id,
            payload = objectMapper.valueToTree(payload),
        )
        return registry.send(hostId, envelope)
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
     * Puts back into the game the agents an operator asked to be there.
     *
     * **The backend's job, not the host's.** The host is where a disconnect is noticed, and it is
     * still the wrong place to answer one: the rule everything else rests on is that a host never
     * changes its own mind about where an agent is. A host that reconnected itself would be
     * asserting a state nobody asked for, and nothing here could tell that apart from an operator's
     * own connect. `wanted` is where the asking is recorded, so the decision stays on this side.
     *
     * **Derived rather than event-driven**, which is why this is a sweep and not a hook on the state
     * report. What needs reconnecting is a fact about the fleet right now - wanted, not online, due -
     * and it reads the same after a backend restart, a missed report, or a host that went away for an
     * hour and came back. A hook would have to fire exactly once on exactly the right transition, and
     * every one it missed would be an agent stranded with nothing to notice it.
     *
     * The cost is latency: a drop is answered up to one sweep late. Against a fifteen-second first
     * delay that is noise.
     */
    @Scheduled(fixedDelay = CONNECT_SWEEP_MS, initialDelay = CONNECT_SWEEP_MS)
    @Transactional
    fun rejoinTheWilling() {
        val now = Instant.now()

        for (agent in agentRepository.findAllByWantedIsTrue()) {
            // Back where it belongs. The backoff describes one absence, so it ends with that absence
            // rather than accumulating across a week of them.
            if (agent.state == AgentState.ONLINE) {
                if (agent.rejoinAttempts != 0 || agent.rejoinAt != null) {
                    agent.rejoinAttempts = 0
                    agent.rejoinAt = null
                }
                continue
            }

            // CONNECTING is already an answer in progress, and the states outside this set need a
            // person - an agent that has lost its credentials is not going to be fixed by dialling.
            if (agent.state !in CONNECTABLE) continue
            if (!rejoins(agent)) continue

            val server = agent.serverAddress ?: continue

            // Nothing to send the command to. Skipped **without consuming an attempt**: a host that
            // is switched off is not the agent failing to join, and counting it would spend the whole
            // budget on an outage and give up right as the host came back.
            if (!agent.host.isReachable()) continue

            // First sight of this absence. Arm the clock rather than reconnecting on the spot - a
            // server that just restarted is not ready, and neither is one that just kicked us.
            if (agent.rejoinAt == null) {
                agent.rejoinAt = now.plus(delayBefore(agent.rejoinAttempts))
                continue
            }
            if (agent.rejoinAt?.isAfter(now) == true) continue

            if (agent.rejoinAttempts >= properties.rejoinAttempts) {
                log.info("Giving up on rejoining {} after {} attempts", agent.label, agent.rejoinAttempts)
                agent.wanted = false
                agent.rejoinAt = null
                // Said once, and only once, which is the reason for the cap. An agent that cannot
                // join this server will not be fixed by another thousand tries, and a warning every
                // five minutes forever is a feed nobody reads.
                activityService.record(
                    agent = agent,
                    scope = ActivityScope.LIFECYCLE,
                    severity = ActivitySeverity.WARNING,
                    text = "Stopped trying to rejoin $server after ${agent.rejoinAttempts} attempts",
                )
                publish(agent)
                continue
            }

            agent.rejoinAttempts += 1
            // Set before the send and regardless of how it goes, so a host that vanished in the
            // meantime costs one delay rather than a retry on every sweep from here on.
            agent.rejoinAt = now.plus(delayBefore(agent.rejoinAttempts))

            if (!offer(agent, CommandType.CONNECT, mapOf("serverAddress" to server))) {
                log.debug("Host {} went away before {} could be rejoined", agent.host.name, agent.label)
                continue
            }

            log.info("Rejoining {} to {}, attempt {}", agent.label, server, agent.rejoinAttempts)
            agent.state = AgentState.CONNECTING
            agent.connectingSince = now
            // Deliberately no audit line. Audit records what a person did, and nobody did this - the
            // person's decision was the `connect` that set `wanted`, and that is already recorded.
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.INFO,
                text = "Reconnecting to $server (attempt ${agent.rejoinAttempts})",
            )
            publish(agent)
        }
    }

    /**
     * Whether this agent is configured to be put back into the game by itself.
     *
     * The **one** setting this side reads. Everything else in the map is the interface's business
     * and the host's, and is relayed without being understood - but a host cannot honour this one
     * without breaking the rule that it never decides where an agent belongs. So the key crosses to
     * the host like all the others, which ignores it, and is acted on here.
     *
     * Anything but `true` is off, unparseable settings included. This turns an agent's own machinery
     * on; guessing at a malformed value would be inferring consent from a typo.
     */
    private fun rejoins(agent: Agent): Boolean {
        val stored = agent.settings?.takeIf { it.isNotBlank() } ?: return false
        val values = runCatching { objectMapper.readTree(stored) }.getOrNull() ?: return false

        return values.get(REJOIN_KEY)?.asString() == "true"
    }

    /**
     * How long to wait before attempt number [attempts], doubling each time up to the configured
     * ceiling.
     *
     * The shift is clamped well below 64 because Kotlin's `shl` takes only the low six bits of its
     * operand: at 64 attempts an unclamped shift wraps to `shl 0` and the backoff silently collapses
     * back to its shortest delay.
     */
    private fun delayBefore(attempts: Int): Duration {
        val grown = properties.rejoinDelay.multipliedBy(1L shl attempts.coerceIn(0, 20))

        return if (grown > properties.rejoinDelayMax) properties.rejoinDelayMax else grown
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
     * **The redundant port is removed, not added.** Both spellings still collapse to one, but they
     * collapse to the one the operator typed. The default port is exactly the case where a host
     * should look the SRV record up - and appending it here made every address look like a deliberate
     * choice of socket, which is how an agent ended up dialling 25565 on a server whose record points
     * somewhere else entirely. An explicitly different port is left alone: naming one is how you say
     * "this exact socket, no lookup".
     *
     * Deliberately simple: a bracketed IPv6 literal without a port already contains colons and is
     * left alone, and a suffix with nothing in front of it is not a port to strip.
     */
    private fun normalizeServer(address: String): String {
        val trimmed = address.trim().lowercase()
        val bare = trimmed.removeSuffix(":$DEFAULT_PORT")

        return bare.ifEmpty { trimmed }
    }

    private companion object {
        val log: Logger = LoggerFactory.getLogger(AgentService::class.java)

        val CONNECTABLE = setOf(AgentState.LINKED, AgentState.CONNECT_FAILED, AgentState.STALE)
        const val DEFAULT_PORT = 25565

        /** Frequent enough that the badge falls back while the operator is still looking at it. */
        const val CONNECT_SWEEP_MS = 5_000L

        /** Declared by the interface, like every other key. See [rejoins] for why this one is read. */
        const val REJOIN_KEY = "connect.rejoin"
    }
}

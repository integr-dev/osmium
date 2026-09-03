package net.integr.osmium.hostlink

import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import net.integr.osmium.agent.dto.AgentInventoryResponse
import net.integr.osmium.agent.dto.AgentTelemetryResponse
import net.integr.osmium.agent.dto.InventorySlotResponse
import net.integr.osmium.agent.dto.NearbyPlayerResponse
import net.integr.osmium.agent.dto.PositionResponse
import net.integr.osmium.agent.dto.toResponse
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.service.AgentInventoryStore
import net.integr.osmium.agent.service.AgentTelemetryPublisher
import net.integr.osmium.agent.service.AgentTelemetryStore
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import net.integr.osmium.activity.service.ActivityService
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.build.service.BuildJobService
import net.integr.osmium.chat.model.ChatScope
import net.integr.osmium.chat.service.ChatService
import net.integr.osmium.chat.service.ChatSpamFilter
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.map.model.MapTile
import net.integr.osmium.map.service.MapService
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.EventType
import net.integr.osmium.hostlink.MessageKind
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.Base64
import java.util.UUID
import net.integr.osmium.host.model.Host
import net.integr.osmium.host.service.HostService

/**
 * Applies what a host reports. The host is the source of truth about its own agents: the backend
 * records what it is told rather than asserting state back.
 */
@Service
class HostReportService(
    private val agentRepository: AgentRepository,
    private val hostService: HostService,
    private val chatService: ChatService,
    private val chatSpamFilter: ChatSpamFilter,
    private val activityService: ActivityService,
    private val buildJobs: BuildJobService,
    private val telemetryStore: AgentTelemetryStore,
    private val inventoryStore: AgentInventoryStore,
    private val telemetryPublisher: AgentTelemetryPublisher,
    private val broker: LiveUpdateBroker,
    private val mapService: MapService,
    private val registry: HostConnections,
    private val objectMapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Transactional
    fun onConnected(hostId: Long, remoteAddress: String?) {
        hostService.recordHeartbeat(hostId = hostId, hostVersion = null, address = remoteAddress)
    }

    @Transactional
    fun onMessage(hostId: Long, envelope: HostEnvelope) {
        when (envelope.kind) {
            MessageKind.EVENT -> onEvent(hostId, envelope)
            MessageKind.RESULT -> onResult(hostId, envelope)
            // The backend issues commands; it does not take them.
            MessageKind.COMMAND -> log.warn("Host {} sent a command '{}', ignoring", hostId, envelope.type)
        }
    }

    private fun onEvent(hostId: Long, envelope: HostEnvelope) {
        when (envelope.type) {
            EventType.HEARTBEAT -> hostService.recordHeartbeat(
                hostId = hostId,
                hostVersion = envelope.payload?.get("hostVersion")?.asString(),
                address = null,
            )

            EventType.HANDSHAKE -> handshake(hostId, envelope)

            EventType.AGENT_STATUS -> applyStatus(hostId, envelope)

            EventType.CHAT -> recordChat(hostId, envelope)

            EventType.ACTIVITY -> recordActivity(hostId, envelope)

            EventType.BUILD_PROGRESS -> recordProgress(hostId, envelope)

            EventType.MAP_TILE -> recordMapTile(hostId, envelope)

            EventType.INVENTORY -> recordInventory(hostId, envelope)

            // Forward compatible by design: a newer host reporting something this backend has not
            // learned about yet is normal, so it is logged and dropped rather than fatal.
            else -> log.debug("Ignoring unknown event '{}' from host {}", envelope.type, hostId)
        }
    }

    private fun onResult(hostId: Long, envelope: HostEnvelope) {
        if (envelope.type == EventType.SETUP_RESULT || envelope.type == "setup_agent") {
            applySetupResult(hostId, envelope)
            return
        }
        log.debug("Result for '{}' (id={}) from host {}", envelope.type, envelope.id, hostId)
    }

    private fun applySetupResult(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return

        if (envelope.ok == true) {
            agent.state = AgentState.LINKED
            // Identity only. A credential must never appear here, and is not read if it does.
            agent.mcUsername = envelope.payload?.get("mcUsername")?.asString()
            agent.mcUuid = envelope.payload?.get("mcUuid")?.asString()
            publish(agent)
        } else {
            // Back to where it started, so the operator can retry rather than being stuck pending.
            agent.state = AgentState.UNLINKED
            log.info(
                "Setup failed for agent {}: {}",
                agent.label,
                envelope.payload?.get("reason")?.asString() ?: "no reason given",
            )
            publish(agent)
        }
    }

    /**
     * What a host says it is, on arrival: what it is running, and what it can log in with.
     *
     * Two independent halves of one message, and each key is optional, so a host that only
     * implements one of them is handled rather than rejected.
     */
    private fun handshake(hostId: Long, envelope: HostEnvelope) {
        envelope.payload?.get("loginMethods")?.takeIf { it.isArray }?.let { advertised ->
            // Copy is optional and only ever shown; the id is the part that has to be there,
            // because it is what comes back in setup_agent.
            val methods = advertised.mapNotNull { node ->
                node.get("id")?.asString()?.takeIf { it.isNotBlank() }?.let { id ->
                    LoginMethod(
                        id = id,
                        label = node.get("label")?.asString(),
                        description = node.get("description")?.asString(),
                    )
                }
            }
            hostService.recordLoginMethods(hostId, methods)
        }

        envelope.payload?.get("agents")?.takeIf { it.isArray }?.let { reconcile(hostId, it) }

        reconfigure(hostId)
    }

    /**
     * Re-sends every configured agent's settings to a host that has just connected.
     *
     * A host holds configuration in memory only — it is the backend that stores what an operator
     * chose — so a restarted one runs on defaults until told otherwise, silently and with nothing
     * saying so. This is the same reasoning as the handshake itself: the connection is new, so
     * everything that was only ever true of the last one has to be said again.
     *
     * Unconfigured agents are skipped rather than sent an empty map. There is nothing to say about
     * an agent nobody has configured, and a host that has just started is already on defaults.
     */
    private fun reconfigure(hostId: Long) {
        for (agent in agentRepository.findAllByHostId(hostId)) {
            val stored = agent.settings?.takeIf { it.isNotBlank() && it != "{}" } ?: continue
            val values = runCatching { objectMapper.readTree(stored) }.getOrNull() ?: continue

            registry.send(
                hostId,
                HostEnvelope(
                    id = "cmd-${UUID.randomUUID()}",
                    kind = MessageKind.COMMAND,
                    type = CommandType.SETTINGS,
                    agentId = agent.id,
                    payload = objectMapper.createObjectNode().apply { set("values", values) },
                ),
            )
        }
    }

    /**
     * Squares what a host says it is running against what the backend believed.
     *
     * Announced agents are applied exactly as `agent_status` would apply them, so a host that kept
     * its sessions across a socket blip changes nothing by saying so.
     *
     * An agent this host owns and did **not** mention is not in game. Its stored state is a claim
     * about a live session, and the only party that can see one has just declined to mention it:
     *
     * - `ONLINE` becomes `LINKED`. The credentials are on the host's disk and outlive a restart;
     *   the session does not.
     * - `SETUP_PENDING` becomes `UNLINKED`, the same place a failed setup lands. The command went
     *   with the process that was going to answer it, so nothing is coming.
     * - `CONNECTING` becomes `LINKED`, the same place a connect that runs out of time lands. The
     *   credentials outlived the restart; the join that was in flight did not.
     *
     * Every other state is left alone: none of them assert a session, so the host's silence says
     * nothing about them.
     */
    private fun reconcile(hostId: Long, reported: JsonNode) {
        val announced = reported.mapNotNull { node -> node.get("agentId")?.asLong() }.toSet()

        for (node in reported) {
            val agentId = node.get("agentId")?.asLong() ?: continue
            val agent = ownedAgent(hostId, agentId)

            if (agent == null) {
                forget(hostId, agentId)
                continue
            }

            applyReportedState(hostId, agent, node.get("state")?.asString())
        }

        for (agent in agentRepository.findAllByHostId(hostId)) {
            if (agent.id in announced) continue

            val corrected = when (agent.state) {
                AgentState.ONLINE -> AgentState.LINKED
                AgentState.SETUP_PENDING -> AgentState.UNLINKED
                AgentState.CONNECTING -> AgentState.LINKED
                else -> continue
            }

            log.info("Host {} did not announce agent {}; {} -> {}", hostId, agent.label, agent.state, corrected)
            agent.state = corrected
            agent.onlineSince = null
            agent.connectingSince = null
            agent.chatListener = false
            buildJobs.releaseSegmentsOf(agent)
            // The operator did not cause this and would otherwise see a state change with no
            // explanation, which is exactly what the activity feed is for.
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.WARNING,
                text = "Host reconnected without this agent, so it is no longer in game",
            )
            publish(agent)
        }
    }

    /**
     * `agent_status` carries two things with very different lifetimes, and they are handled apart.
     *
     * The **state** is a rare, durable fact: it is written and published only when it actually
     * changes, so a host reporting `ONLINE` every few seconds costs nothing. The **telemetry** is a
     * continuous sample: taken every time, kept in memory, and published on its own lightweight
     * event rather than re-sending the whole agent. Treating them alike would mean either an
     * `agent` event per tick, or vitals that only update when an agent connects.
     *
     * Either half may be absent. A host with nothing new to say about state can send telemetry
     * alone, and vice versa.
     */
    private fun applyStatus(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        applyState(hostId, agent, envelope)
        applyTelemetry(agent, envelope)
    }

    private fun applyState(hostId: Long, agent: Agent, envelope: HostEnvelope) {
        applyReportedState(hostId, agent, envelope.payload?.get("state")?.asString())
    }

    /** Shared with the arrival announcement, which reports the same states in a different shape. */
    private fun applyReportedState(hostId: Long, agent: Agent, reported: String?) {
        if (reported == null) return

        val state = runCatching { AgentState.valueOf(reported) }.getOrNull()
        if (state == null) {
            log.debug("Ignoring unknown agent state '{}' from host {}", reported, hostId)
            return
        }
        // STALE is derived from host reachability, never reported: a host that can talk to us is
        // by definition not stale.
        if (state == AgentState.STALE) return

        // The whole point of the live channel: a state change the operator did not cause is the one
        // thing polling would otherwise have to discover.
        if (agent.state != state) {
            agent.state = state
            // Chat listener election ranks by session length, so the clock starts on entering the
            // game and stops on leaving it. A reconnect is a new session, not a continuation.
            agent.onlineSince = if (state == AgentState.ONLINE) Instant.now() else null
            // The host has answered, so the clock the answer was being waited on stops. Left set, a
            // later CONNECTING would inherit a deadline that expired long before it began.
            agent.connectingSince = if (state == AgentState.CONNECTING) agent.connectingSince else null
            // An agent that left the game has stopped forwarding whatever it was forwarding. Saying
            // so here means the next election sees a vacancy rather than a listener that is gone.
            if (state != AgentState.ONLINE) agent.chatListener = false
            // And what it was carrying is no longer what it is carrying. This is what bounds the
            // inventory's life instead of a clock: it is only ever reported when items move, so
            // there is nothing to go stale, only a session to end. It says so again on its next
            // spawn.
            if (state != AgentState.ONLINE) agent.id?.let { inventoryStore.forget(it) }
            // And it has stopped building. The segment goes back to the pool rather than to FAILED:
            // losing the builder is not failure of the work.
            if (state != AgentState.ONLINE) buildJobs.releaseSegmentsOf(agent)
            // Coming back is the other half of that. Without it a reconnect left the agent standing
            // beside the build it had been on doing nothing, because releasing its segment was the
            // last thing anybody did about it.
            if (state == AgentState.ONLINE) buildJobs.reassignIdle(agent)
            publish(agent)
        }
    }

    /**
     * Reads the vitals half, which is present only on some ticks.
     *
     * **All four core readings are required together.** Defaulting a missing one would be inventing
     * a measurement: an absent `food` becoming `0` renders as a starving agent and raises an alert
     * about an agent that is fine, and an absent `position` becoming the origin puts it somewhere it
     * has never been. That is the same fabrication `telemetry = null` exists to prevent, so a
     * partial tick is dropped whole and logged rather than patched up.
     *
     * `dimension` and `nearby` do default, because "overworld" and "nobody nearby" are cheap to be
     * wrong about and neither drives an alert.
     */
    private fun applyTelemetry(agent: Agent, envelope: HostEnvelope) {
        val payload = envelope.payload ?: return
        val agentId = agent.id ?: return

        val health = payload.get("health")?.asInt()
        val food = payload.get("food")?.asInt()
        val pingMs = payload.get("pingMs")?.asInt()
        val position = positionFrom(payload.get("position"))

        // No vitals at all is the ordinary case: this was a state report.
        if (health == null && food == null && pingMs == null && position == null) return

        if (health == null || food == null || pingMs == null || position == null) {
            log.warn(
                "Dropping a partial telemetry sample for agent {}: health, food, pingMs and position " +
                    "are required together",
                agent.label,
            )
            return
        }

        val telemetry = AgentTelemetryResponse(
            health = health,
            food = food,
            position = position,
            dimension = payload.get("dimension")?.asString() ?: "overworld",
            pingMs = pingMs,
            nearby = nearbyFrom(payload),
        )

        telemetryStore.record(agentId, telemetry)
        // Marked rather than published. Reports arrive as fast as hosts choose to send them; the
        // browser is fed on a fixed tick carrying the latest reading. See AgentTelemetryPublisher.
        telemetryPublisher.reported(agentId)
    }

    /**
     * Whether a nearby player is one of ours is decided **here, not by the host**. A host sees only
     * its own agents, and a server's fleet can span several hosts, so it cannot tell one of ours
     * from a stranger. The host reports names, distances and positions; the backend knows the fleet.
     *
     * A player's `position` is optional where the agent's own is required. An absent one is reported
     * as absent rather than dropping the entry: the fact that somebody is standing there matters
     * more than knowing exactly where, and a host can legitimately have the distance without a
     * usable position.
     */
    private fun nearbyFrom(payload: JsonNode): List<NearbyPlayerResponse> {
        val reported = payload.get("nearby")?.takeIf { it.isArray } ?: return emptyList()
        if (reported.isEmpty) return emptyList()

        val ours = agentRepository.findAll().mapNotNullTo(mutableSetOf()) { it.mcUsername?.lowercase() }

        return reported.mapNotNull { entry ->
            val name = entry.get("name")?.asString() ?: return@mapNotNull null
            NearbyPlayerResponse(
                name = name,
                distance = entry.get("distance")?.asDouble() ?: 0.0,
                position = positionFrom(entry.get("position")),
                // Absent rather than defaulted: a host that did not report a ping is not a player
                // with a ping of zero, and the interface can say which.
                uuid = entry.get("uuid")?.asString(),
                ping = entry.get("ping")?.takeIf { it.isNumber }?.asInt(),
                gamemode = entry.get("gamemode")?.takeIf { it.isNumber }?.asInt(),
                // Not clamped to twenty: a player under a health boost genuinely has more, and
                // capping it would report a lie about somebody who is harder to kill than they look.
                health = entry.get("health")?.takeIf { it.isNumber }?.asDouble()?.takeIf { it >= 0 },
                isAgent = name.lowercase() in ours,
            )
        }
    }

    /**
     * A position, or null when any part of it is missing. All three or none — two coordinates plus a
     * guess for the third is a point nobody was ever at, and it would render as confidently as a
     * real one.
     */
    private fun positionFrom(node: JsonNode?): PositionResponse? {
        val x = node?.get("x")?.asDouble() ?: return null
        val y = node.get("y")?.asDouble() ?: return null
        val z = node.get("z")?.asDouble() ?: return null
        return PositionResponse(x = x, y = y, z = z)
    }

    /**
     * A line the host classified. An unrecognised scope is dropped rather than guessed at: filing
     * chat into the wrong feed is worse than losing it, since the whole point of the split is that
     * an incident is not buried in conversation.
     */
    /**
     * How far through a segment an agent is.
     *
     * Read here and applied by the job service, which owns what a count means. The agent is
     * resolved the way every other report is — through the host that owns it — so a host cannot
     * report on an agent that is not its own, and the service then checks the segment is one that
     * agent actually holds.
     */
    private fun recordProgress(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        val payload = envelope.payload ?: return

        val segmentId = payload.get("segmentId")?.asLong() ?: return

        buildJobs.recordProgress(
            agent = agent,
            segmentId = segmentId,
            blocksPlaced = payload.get("blocksPlaced")?.asLong(),
            state = payload.get("state")?.asString(),
            reason = payload.get("reason")?.asString(),
        )
    }

    private fun recordChat(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        val payload = envelope.payload ?: return

        val scope = enumOrNull<ChatScope>(payload.get("scope")?.asString())
        val text = payload.get("text")?.asString()
        if (scope == null || text.isNullOrBlank()) {
            log.debug("Ignoring malformed chat event from host {}", hostId)
            return
        }

        // Falls back to the agent's own name, which is who said it when the scope is outbound.
        val from = payload.get("from")?.asString() ?: agent.label

        /*
         * The room, and only the room, is filtered for repetition.
         *
         * Global chat is 98% of what is stored and all of it is strangers talking, so it is both the
         * volume worth defending against and the stream where losing a line costs least. The other
         * two are neither: an agent's own outbound lines are audited and few, and a whisper is
         * somebody addressing this fleet directly - a player repeating a request because an agent
         * has not answered yet is the last person to stop listening to.
         *
         * `typed` is the line with the server's decoration removed, which only the host can do. It
         * is read for the comparison and then dropped: `text` already holds the whole line, and a
         * column for it would cost a migration on the table this exists to keep small.
         */
        if (scope == ChatScope.GLOBAL) {
            val verdict = chatSpamFilter.judge(
                serverAddress = agent.serverAddress.orEmpty(),
                sender = from,
                typed = payload.get("typed")?.asString(),
            )

            if (verdict is ChatSpamFilter.Verdict.Drop) {
                chatService.suppressed(agent, from, verdict.run)
                return
            }
        }

        chatService.record(
            agent = agent,
            scope = scope,
            from = from,
            text = text,
            // Re-serialised, never interpreted. This backend holds no opinion about what a chat
            // component is - the host resolved the server's translation keys and dropped everything
            // interactive before sending it - and going back through the node that already parsed is
            // what guarantees the stored string is valid JSON.
            components = payload.get("components")?.takeIf { it.isObject }?.toString(),
        )
    }

    private fun recordActivity(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        val payload = envelope.payload ?: return

        val scope = enumOrNull<ActivityScope>(payload.get("scope")?.asString())
        val text = payload.get("text")?.asString()
        if (scope == null || text.isNullOrBlank()) {
            log.debug("Ignoring malformed activity event from host {}", hostId)
            return
        }

        activityService.record(
            agent = agent,
            scope = scope,
            // Optional on the wire: a host that reports what happened without rating it still gets
            // the line recorded, and INFO is the reading that claims least.
            severity = enumOrNull<ActivitySeverity>(payload.get("severity")?.asString())
                ?: ActivitySeverity.INFO,
            text = text,
        )
    }

    /**
     * One chunk of the world as an agent saw it from above.
     *
     * Decoded but not interpreted: the palette is block names this backend holds no opinion about,
     * and the two byte arrays are pixels it never looks at. What it does check is the shape, over in
     * [net.integr.osmium.map.model.MapTile.wellFormed] - a tile of the wrong length is a row every
     * later reader would have to defend against, and a browser drawing it would run off the end of
     * the array.
     */
    private fun recordMapTile(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        val payload = envelope.payload ?: return

        val x = payload.get("x")?.takeIf { it.isNumber }?.asInt()
        val z = payload.get("z")?.takeIf { it.isNumber }?.asInt()
        val palette = payload.get("palette")?.takeIf { it.isArray }
            ?.mapNotNull { entry -> entry.asString()?.takeIf { name -> name.isNotBlank() } }
        val blocks = payload.get("blocks")?.asString()?.let { decodeBase64(it) }
        val heights = payload.get("heights")?.asString()?.let { decodeBase64(it) }

        if (x == null || z == null || palette == null || blocks == null || heights == null) {
            log.debug("Ignoring malformed map tile from host {}", hostId)
            return
        }

        mapService.record(
            agent = agent,
            tile = MapTile(
                // A host too old to say which world it is in is reporting from an agent that is
                // nonetheless somewhere, and the ordinary world is the only guess that is right
                // most of the time. Trimmed to the column's width rather than refused: a modded
                // namespace longer than this is still better placed under a truncated name than
                // dropped.
                dimension = (payload.get("dimension")?.asString()?.takeIf { it.isNotBlank() }
                    ?: MapTile.DEFAULT_DIMENSION).take(MapTile.DIMENSION_MAX),
                x = x,
                z = z,
                palette = palette,
                blocks = blocks,
                heights = heights,
                agentId = agent.id,
                agentLabel = agent.label,
                // Received, not observed - the rule chat follows, for the same reason. Host clocks
                // are not synchronised with each other, and a skewed one would date its tiles into
                // the future, where they would outrank every later correction to the same chunk.
                at = Instant.now(),
            ),
        )
    }

    /**
     * Records what an agent is carrying, and says so at once.
     *
     * Published as it arrives rather than coalesced onto a tick like the vitals. An inventory event
     * only exists because items moved, so there is no burst to flatten - and half of what this
     * screen is for is watching an item leave the square an operator just dropped it from.
     *
     * A malformed slot is dropped and the rest of the inventory kept. A square is independent of
     * every other square, so refusing the whole report over one of them would blank a screen that
     * was about to be almost entirely right.
     */
    private fun recordInventory(hostId: Long, envelope: HostEnvelope) {
        val agent = resolve(hostId, envelope) ?: return
        val agentId = agent.id ?: return
        val payload = envelope.payload ?: return

        val slots = payload.get("slots")?.takeIf { it.isArray }?.mapNotNull { slotOf(it) }
        if (slots == null) {
            log.debug("Ignoring an inventory with no slots from host {}", hostId)
            return
        }

        val inventory = AgentInventoryResponse(
            slots = slots,
            // A host too old to say what is in hand is reporting an inventory that is still worth
            // drawing, and the first hotbar square is where a client would put the highlight anyway.
            held = payload.get("held")?.takeIf { it.isNumber }?.asInt() ?: 0,
        )

        inventoryStore.record(agentId, inventory)
        broker.publish(
            LiveUpdateEvent(
                type = LiveUpdateType.AGENT_INVENTORY,
                data = mapOf("agentId" to agentId, "inventory" to inventory),
                agentId = agentId,
            ),
        )
    }

    /** One square, or null when it does not carry the four things every square needs. */
    private fun slotOf(node: JsonNode): InventorySlotResponse? {
        val slot = node.get("slot")?.takeIf { it.isNumber }?.asInt() ?: return null
        val name = node.get("name")?.asString()?.takeIf { it.isNotBlank() } ?: return null
        val count = node.get("count")?.takeIf { it.isNumber }?.asInt() ?: return null

        // Together or not at all. A damage with no maximum is a bar with nothing to fill, and a
        // maximum with no damage would draw a full one on an item nobody knows the wear of.
        val damage = node.get("damage")?.takeIf { it.isNumber }?.asInt()
        val maxDamage = node.get("maxDamage")?.takeIf { it.isNumber }?.asInt()
        val worn = damage != null && maxDamage != null && maxDamage > 0

        return InventorySlotResponse(
            slot = slot,
            name = name,
            // Falls back to the id, which is a worse label but never an empty one.
            displayName = node.get("displayName")?.asString()?.takeIf { it.isNotBlank() } ?: name,
            count = count,
            damage = if (worn) damage else null,
            maxDamage = if (worn) maxDamage else null,
        )
    }

    /** Base64 as sent, or null for anything that is not. */
    private fun decodeBase64(raw: String): ByteArray? = try {
        Base64.getDecoder().decode(raw)
    } catch (invalid: IllegalArgumentException) {
        log.debug("A map tile carried something that is not base64: {}", invalid.message)
        null
    }

    /** Wire values are lower case; an unknown one is null rather than an exception. */
    private inline fun <reified T : Enum<T>> enumOrNull(raw: String?): T? =
        raw?.let { value -> enumValues<T>().firstOrNull { it.name.equals(value, ignoreCase = true) } }

    private fun publish(agent: Agent) = broker.publish(
        // Telemetry is looked up rather than omitted: this event replaces the agent in the browser,
        // so leaving it null would read as "stopped reporting" every time the state changed.
        LiveUpdateEvent(
            type = LiveUpdateType.AGENT_CHANGED,
            data = agent.toResponse(telemetryStore.find(agent.id)),
            agentId = agent.id,
        ),
    )

    /** Rejects a host reporting on an agent it does not own, rather than trusting the agentId. */
    private fun resolve(hostId: Long, envelope: HostEnvelope) =
        envelope.agentId?.let { ownedAgent(hostId, it) }
            ?: run {
                log.warn("Host {} reported on agent {} it does not own", hostId, envelope.agentId)
                null
            }

    /** A host may only speak about the agents it owns, however the id reached us. */
    /**
     * Tells a host to release an agent it announced but this backend does not own.
     *
     * The other half of the reconciliation. [reconcile] corrects what the backend believed from
     * what the host says it runs; this corrects what the host still holds from what the backend
     * knows exists.
     *
     * A host binds each credential to the agent it was acquired for, so it can rebuild its agents
     * after a restart. Deleting an agent sends `delete_agent` there and then - but only best
     * effort, so a host that was switched off at that moment never heard, and goes on holding an
     * account for something nobody can use. Saying so on every connect makes that self-correcting
     * without any new message or any bookkeeping to get wrong.
     *
     * Deliberately scoped to ids the host itself announced, and only where the id resolves to
     * nothing **this** host owns. An agent that has been reassigned elsewhere has equally stopped
     * being this one's, and one that simply belongs to another host was never in its list to begin
     * with.
     */
    private fun forget(hostId: Long, agentId: Long) {
        log.info("Host {} announced agent {}, which it does not own; asking it to release", hostId, agentId)

        registry.send(
            hostId,
            HostEnvelope(
                id = "cmd-${UUID.randomUUID()}",
                kind = MessageKind.COMMAND,
                type = CommandType.DELETE_AGENT,
                agentId = agentId,
            ),
        )
    }

    private fun ownedAgent(hostId: Long, agentId: Long): Agent? =
        agentRepository.findById(agentId).orElse(null)?.takeIf { it.host.id == hostId }
}

package net.integr.osmium.map.service

import jakarta.annotation.PreDestroy
import net.integr.osmium.agent.dto.AgentTelemetryResponse
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.map.model.LastSeen
import net.integr.osmium.map.model.SubjectKind
import net.integr.osmium.map.repository.LastSeenRepository
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * Where everybody was, the last time anybody could see them.
 *
 * The map draws the fleet and the people around it from telemetry, which describes only the moment
 * it arrived: an agent that leaves the game, or a player who walks out of every agent's view,
 * simply stops being in it. What they leave behind is a real position that was true when it was
 * taken, and this is where it is kept - so a screen opened an hour later can still say where
 * somebody was, in grey, rather than pretending nobody was ever there.
 *
 * **Nothing here expires.** A sighting is deleted from the storage screen, deliberately, and not by
 * a clock: the whole value of an old position is that it is the only one there is. See
 * `StorageArea.POSITIONS`.
 *
 * **Buffered, then written in one batch.** Telemetry arrives about once a second per agent and
 * carries everybody standing near it, so writing each sighting as it lands would be a round trip
 * per player per second for a fact nobody reads until they have gone. The newest sighting of each
 * subject is held in memory and flushed every fifteen seconds - which means the stored position can be
 * up to that far behind the live one, and it does not matter: while somebody is in view the screen
 * is drawing them from telemetry, and this is only ever read about the people who are not.
 */
@Service
class LastSeenService(private val positions: LastSeenRepository) {
    private val log = LoggerFactory.getLogger(javaClass)

    /** The newest sighting of each subject since the last flush, by [LastSeen.key]. */
    private val pending = ConcurrentHashMap<String, LastSeen>()

    /**
     * Takes everything one telemetry sample says about where people are.
     *
     * The agent's own position, and every player near it who is not one of ours. **Other agents are
     * skipped**, not because their position is unwanted but because they report it themselves, from
     * where they are actually standing rather than from what a neighbour could make out.
     *
     * An agent between servers is dropped rather than filed somewhere: a position with no address
     * belongs to no map.
     */
    fun record(agent: Agent, telemetry: AgentTelemetryResponse) {
        val server = agent.serverAddress?.takeUnless { it.isBlank() } ?: return
        val agentId = agent.id ?: return
        val now = Instant.now()

        remember(
            LastSeen(
                serverAddress = server,
                dimension = telemetry.dimension,
                kind = SubjectKind.AGENT,
                subject = agentId.toString(),
                label = agent.label,
                face = agent.mcUuid ?: agent.mcUsername,
                x = telemetry.position.x,
                y = telemetry.position.y,
                z = telemetry.position.z,
                at = now,
            ),
        )

        for (player in telemetry.nearby) {
            if (player.isAgent) continue
            // A player the host could see but not place. Where they are is the whole of this row,
            // so there is nothing to store about them.
            val at = player.position ?: continue

            remember(
                LastSeen(
                    serverAddress = server,
                    dimension = telemetry.dimension,
                    kind = SubjectKind.PLAYER,
                    subject = player.name,
                    label = player.name,
                    face = player.uuid ?: player.name,
                    x = at.x,
                    y = at.y,
                    z = at.z,
                    at = now,
                ),
            )
        }
    }

    /**
     * Holds the newest sighting of one subject.
     *
     * Trimmed to what the columns hold rather than refused. Names arrive from a Minecraft server by
     * way of a host, and a row lost over a long one would be a person missing from the record with
     * nothing said about why.
     */
    private fun remember(seen: LastSeen) {
        val trimmed = seen.copy(
            subject = seen.subject.take(LastSeen.TEXT_MAX),
            label = seen.label.take(LastSeen.TEXT_MAX),
            face = seen.face?.take(LastSeen.TEXT_MAX),
            dimension = seen.dimension.take(LastSeen.TEXT_MAX),
        )
        pending.merge(trimmed.key, trimmed) { held, arriving ->
            if (arriving.at >= held.at) arriving else held
        }
    }

    /**
     * Writes what has been seen since the last time.
     *
     * Drained before the write, so a sample arriving during it is kept for the next round rather
     * than lost. A failure loses one round of sightings and says so: the next telemetry tick
     * replaces them for everybody still in view, and the only rows genuinely lost are the last
     * positions of people who left during that window.
     *
     * Every fifteen seconds, which is how far behind the live position a stored one can be: a
     * sprint's worth of blocks, and the right trade, because this row is read about people nobody
     * can see and while they can be seen the screen is not reading it. Settable as
     * `osmium.map.last-seen-flush-ms` only so the test suite can push it out of the way - a flush
     * on a timer commits rows outside the transaction each test is rolled back with, which makes
     * every assertion about who was last seen where depend on when it happened to fire.
     */
    @Scheduled(
        fixedDelayString = "\${osmium.map.last-seen-flush-ms:15000}",
        initialDelayString = "\${osmium.map.last-seen-flush-ms:15000}",
    )
    fun flush() {
        if (pending.isEmpty()) return

        val batch = pending.keys.mapNotNull { pending.remove(it) }
        if (batch.isEmpty()) return

        try {
            positions.upsertAll(batch)
        } catch (err: Exception) {
            log.warn("Dropping {} sightings: {}", batch.size, err.message)
        }
    }

    /** So a restart does not throw away the last few seconds of it. */
    @PreDestroy
    fun onShutdown() = flush()

    /**
     * Everyone last seen in one world, newest first and capped.
     *
     * The cap is the answer to nothing expiring: a busy server holds every account that has ever
     * walked past an agent, and a map that drew all of them would be a wall of grey heads over the
     * terrain it is meant to show. What an operator is looking for is who was here recently.
     */
    fun inWorld(serverAddress: String, dimension: String): List<LastSeen> =
        positions.inWorld(serverAddress, dimension, MOST)

    companion object {
        /** The most sightings one world will answer with. */
        const val MOST = 500
    }
}

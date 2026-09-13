package net.integr.osmium.map.service

import net.integr.osmium.agent.model.Agent
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.map.dto.MapTileChangedResponse
import net.integr.osmium.map.dto.toResponse
import net.integr.osmium.map.model.MapTile
import net.integr.osmium.map.repository.MapExtent
import net.integr.osmium.map.repository.MapTileRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/**
 * The stored map: what agents have seen from above, per server.
 *
 * Keyed by the server and not by the agent, because a map is about a place. Every agent on an
 * address fills in the same one, which is the whole point - a fleet that has walked a build site
 * between them has charted it between them.
 */
@Service
class MapService(
    private val tiles: MapTileRepository,
    private val broker: LiveUpdateBroker,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    /**
     * Records what an agent saw, if it is the shape a map expects.
     *
     * An agent between servers is dropped rather than filed somewhere: a tile with no address
     * belongs to no map, and picking one would put a reading of one world onto another's.
     */
    @Transactional
    fun record(agent: Agent, tile: MapTile) {
        val server = agent.serverAddress
        if (server.isNullOrBlank()) {
            log.debug("Dropping a map tile from '{}', which is not on a server", agent.label)
            return
        }
        if (!tile.wellFormed()) {
            log.warn("Dropping a malformed map tile from '{}' at {},{}", agent.label, tile.x, tile.z)
            return
        }

        tiles.upsert(server, tile)

        // After the commit, like every other change: a map drawing a tile the row then did not keep
        // would be showing ground nobody charted.
        broker.publish(
            LiveUpdateEvent(
                type = LiveUpdateType.MAP_TILE,
                data = MapTileChangedResponse(serverAddress = server, dimension = tile.dimension, tile = tile.toResponse()),
                agentId = agent.id,
            ),
        )
    }

    /**
     * The part of a server's map inside a rectangle of chunks.
     *
     * Bounded rather than paged. A map is read as an area and drawn all at once, so a cursor would
     * only let a caller ask for more than a screen can show - and each tile is most of a kilobyte,
     * so "more" gets expensive quickly. A window past [MAX_TILES] is refused, and the caller either
     * asks for less or draws at a coarser zoom.
     */
    fun area(
        serverAddress: String,
        dimension: String,
        minX: Int,
        minZ: Int,
        maxX: Int,
        maxZ: Int,
    ): List<MapTile> {
        require(minX <= maxX && minZ <= maxZ) { "The area is inside out" }

        // Each side before the area, and both in Long. Widening alone is not enough: the whole
        // integer range is 2^32 chunks across, and squaring that is exactly 2^64, which wraps a
        // Long to zero - an area larger than any world would have passed the check it exists for.
        // Bounding the sides first means the product can never exceed MAX_TILES squared.
        val width = maxX.toLong() - minX + 1
        val depth = maxZ.toLong() - minZ + 1
        require(width <= MAX_TILES && depth <= MAX_TILES && width * depth <= MAX_TILES) {
            "That area is $width by $depth chunks; at most $MAX_TILES fit in one request"
        }

        return tiles.inArea(serverAddress, dimension, minX = minX, minZ = minZ, maxX = maxX, maxZ = maxZ)
    }

    /** Every server and world that has been charted, so a screen knows what it can offer. */
    fun extents(): List<MapExtent> = tiles.extents()

    companion object {
        /**
         * The most tiles one request may ask for.
         *
         * A 64 by 64 window is 1024 chunks - a kilometre square, which is more world than fits on a
         * screen at one pixel per block.
         */
        const val MAX_TILES = 4_096L
    }
}

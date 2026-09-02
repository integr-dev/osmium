package net.integr.osmium.map.repository

import net.integr.osmium.map.model.MapTile
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.sql.Timestamp

/**
 * The stored map, read and written through JDBC.
 *
 * Written far more often than read, always as a whole row, and never partially updated - the same
 * shape as the schematic index, and mapped the same way for the same reasons. Mapping tiles as
 * entities would build a managed object per chunk an agent walks over, for rows nothing ever edits.
 */
@Repository
class MapTileRepository(private val jdbc: JdbcTemplate) {

    /**
     * Records what an agent saw, replacing whatever was there.
     *
     * Last look wins. The world is shared and changes under everyone, so a tile from ten seconds
     * ago is a better description of a place than one from yesterday - even when the older one came
     * from an agent that was standing closer.
     */
    fun upsert(serverAddress: String, tile: MapTile) {
        jdbc.update(
            """
            INSERT INTO map_tiles
                (server_address, dimension, chunk_x, chunk_z, palette, blocks, heights,
                 agent_id, agent_label, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (server_address, dimension, chunk_x, chunk_z) DO UPDATE SET
                palette = EXCLUDED.palette,
                blocks = EXCLUDED.blocks,
                heights = EXCLUDED.heights,
                agent_id = EXCLUDED.agent_id,
                agent_label = EXCLUDED.agent_label,
                at = EXCLUDED.at
            """.trimIndent(),
            serverAddress,
            tile.dimension,
            tile.x,
            tile.z,
            tile.palette.joinToString(SEPARATOR),
            tile.blocks,
            tile.heights,
            tile.agentId,
            tile.agentLabel,
            Timestamp.from(tile.at),
        )
    }

    /**
     * Every tile inside a rectangle of chunks, corners included.
     *
     * Ordered so a caller streaming them draws in a stable sequence rather than wherever the
     * planner happened to find rows.
     */
    fun inArea(
        serverAddress: String,
        dimension: String,
        minX: Int,
        minZ: Int,
        maxX: Int,
        maxZ: Int,
    ): List<MapTile> = jdbc.query(
        """
        SELECT dimension, chunk_x, chunk_z, palette, blocks, heights, agent_id, agent_label, at
        FROM map_tiles
        WHERE server_address = ? AND dimension = ?
          AND chunk_x BETWEEN ? AND ? AND chunk_z BETWEEN ? AND ?
        ORDER BY chunk_z, chunk_x
        """.trimIndent(),
        { rs, _ -> read(rs) },
        serverAddress,
        dimension,
        minX,
        maxX,
        minZ,
        maxZ,
    )

    /**
     * What has been charted, one row per server and world, newest activity first.
     *
     * One query rather than a list of servers and a lookup each: a screen needs every world it can
     * offer before it can draw any of them, and there are three of them per server.
     */
    fun extents(): List<MapExtent> = jdbc.query(
        """
        SELECT server_address, dimension, COUNT(*) AS tiles,
               MIN(chunk_x) AS min_x, MAX(chunk_x) AS max_x,
               MIN(chunk_z) AS min_z, MAX(chunk_z) AS max_z, MAX(at) AS at
        FROM map_tiles
        GROUP BY server_address, dimension
        ORDER BY MAX(at) DESC
        """.trimIndent(),
    ) { rs, _ ->
        MapExtent(
            serverAddress = rs.getString("server_address"),
            dimension = rs.getString("dimension"),
            tiles = rs.getLong("tiles"),
            minX = rs.getInt("min_x"),
            maxX = rs.getInt("max_x"),
            minZ = rs.getInt("min_z"),
            maxZ = rs.getInt("max_z"),
            at = rs.getTimestamp("at").toInstant(),
        )
    }

    private fun read(rs: ResultSet): MapTile = MapTile(
        dimension = rs.getString("dimension"),
        x = rs.getInt("chunk_x"),
        z = rs.getInt("chunk_z"),
        // An empty palette cannot be stored - `wellFormed` refuses it - so a split never yields the
        // one-empty-string list that splitting "" would.
        palette = rs.getString("palette").split(SEPARATOR),
        blocks = rs.getBytes("blocks"),
        heights = rs.getBytes("heights"),
        agentId = rs.getLong("agent_id").takeUnless { rs.wasNull() },
        agentLabel = rs.getString("agent_label"),
        at = rs.getTimestamp("at").toInstant(),
    )

    private companion object {
        /**
         * What separates palette entries.
         *
         * Safe as a plain character because a block name is a Minecraft resource id - lower case
         * letters, digits and underscore - and cannot contain one.
         */
        const val SEPARATOR = ","
    }
}

/** What one world of one server's map covers. */
data class MapExtent(
    val serverAddress: String,
    val dimension: String,
    val tiles: Long,
    val minX: Int,
    val maxX: Int,
    val minZ: Int,
    val maxZ: Int,
    val at: java.time.Instant,
)

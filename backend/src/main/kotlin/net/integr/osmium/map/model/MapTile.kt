package net.integr.osmium.map.model

import java.time.Instant

/**
 * One chunk of a server's map: 16x16 pixels, one per block column, at vanilla's zoom zero.
 *
 * **The backend holds no opinion about what any of this looks like.** [palette] carries block
 * names, not colours; which colour a block reads as is a question about textures, and those live in
 * the frontend beside the atlas the 3D view is drawn from. That split is what keeps the two views
 * agreeing, and what lets the whole stored map be re-coloured without re-walking the world.
 *
 * Not a JPA entity. A map is written far more often than it is read, always as a whole row, and
 * never partially updated - the same shape as the schematic index, and mapped through JDBC for the
 * same reasons.
 */
data class MapTile(
    /**
     * Which world, without its `minecraft:` prefix - `overworld`, `the_nether`, `the_end`, or
     * whatever a modded server calls its own.
     *
     * Part of what identifies a tile, not a label on it. The dimensions are separate worlds at the
     * same coordinates, so a Nether tile and an Overworld tile at `0,0` are two readings of two
     * places rather than two readings of one.
     */
    val dimension: String,
    /** Chunk coordinates, not block ones. */
    val x: Int,
    val z: Int,
    /** The distinct blocks on this tile's surface, indexed by [blocks]. At most [AREA] of them. */
    val palette: List<String>,
    /** [AREA] bytes, row-major from the north-west corner, each an index into [palette]. */
    val blocks: ByteArray,
    /** [AREA] signed 16-bit little-endian heights, or [EMPTY] where the column held nothing. */
    val heights: ByteArray,
    /** Which agent last looked, and when. Null id for one that has since been deleted. */
    val agentId: Long?,
    val agentLabel: String,
    val at: Instant,
) {
    /**
     * Whether this tile is the shape the map expects.
     *
     * Checked because it arrives from a host, and a tile of the wrong length is a row that every
     * later reader has to defend against - the browser drawing it would run off the end of the
     * array and paint whatever was next in memory. Refused at the door instead.
     */
    fun wellFormed(): Boolean =
        blocks.size == AREA &&
            heights.size == AREA * 2 &&
            palette.isNotEmpty() &&
            palette.size <= AREA &&
            blocks.none { it.toInt() and 0xff >= palette.size }

    // Data class over arrays: the generated equals compares them by identity, which is never what
    // is meant. Only tests compare tiles, and they compare the contents.
    override fun equals(other: Any?): Boolean =
        this === other ||
            (other is MapTile && dimension == other.dimension && x == other.x && z == other.z && at == other.at)

    override fun hashCode(): Int = 31 * (31 * (31 * x + z) + dimension.hashCode()) + at.hashCode()

    companion object {
        /** Blocks per tile edge. */
        const val TILE = 16

        /** Pixels in a tile, and the most distinct blocks one can carry. */
        const val AREA = TILE * TILE

        /** The height of a column with nothing to draw. Out of range of any world. */
        const val EMPTY = -32768

        /**
         * The world a tile is filed under when the host did not say.
         *
         * A host old enough not to send one is reporting from an agent that is somewhere, and the
         * ordinary world is the only guess that is right most of the time. Named rather than
         * inlined so the migration that backfilled the same value and this agree by construction.
         */
        const val DEFAULT_DIMENSION = "overworld"

        /** Long enough for a modded namespace; the column is sized to match. */
        const val DIMENSION_MAX = 64
    }
}

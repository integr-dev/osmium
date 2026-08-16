package net.integr.osmium.schematic

/** A point in the schematic's own coordinate space. */
data class Vec3i(val x: Int, val y: Int, val z: Int)

/**
 * One entry of a region's palette: a block name and the properties that distinguish this state of
 * it from the others. Kept as written rather than resolved against a block registry — Osmium does
 * not need to know what a block *is*, only how many there are and where.
 */
data class BlockState(val name: String, val properties: Map<String, String> = emptyMap()) {

    /** True for the three block names that mean nothing is there. */
    val isAir: Boolean get() = name in AIR_NAMES

    companion object {
        /**
         * All three, and all three are needed: a schematic captured above ground is full of
         * `air`, one from a cave is full of `cave_air`, and one from the end or a custom dimension
         * carries `void_air`. Treating only the first as empty makes an underground build read as
         * a solid cube, which is not a subtle error but is a silent one.
         */
        private val AIR_NAMES = setOf("minecraft:air", "minecraft:cave_air", "minecraft:void_air")

        /**
         * Parses the single-string form Sponge palettes use, `minecraft:oak_stairs[facing=east]`.
         *
         * Litematica stores the name and the properties as separate tags, so it needs none of this.
         */
        fun parse(spec: String): BlockState {
            val open = spec.indexOf('[')
            if (open < 0) return BlockState(spec.trim())

            val name = spec.substring(0, open).trim()
            val close = spec.lastIndexOf(']')
            if (close < open) return BlockState(name)

            val properties = spec.substring(open + 1, close)
                .split(',')
                .mapNotNull { pair ->
                    val equals = pair.indexOf('=')
                    if (equals < 0) null
                    else pair.substring(0, equals).trim() to pair.substring(equals + 1).trim()
                }
                .toMap()

            return BlockState(name, properties)
        }
    }
}

/** Which of the two formats a file turned out to be. */
enum class SchematicFormat { LITEMATIC, SPONGE }

/**
 * One region of a schematic.
 *
 * Litematica files hold several, which is not an edge case at the sizes Osmium accepts: an NBT
 * array length is a signed 32-bit int, so a single region cannot express much more than two billion
 * positions however it is packed, and anything larger is necessarily split across regions.
 *
 * [origin] is the minimum corner and [size] is always positive, whatever the file said. Litematica
 * is free to write a negative extent, meaning the region runs backwards from its stated position;
 * normalising here means nothing downstream has to know that.
 */
data class RegionInfo(
    val name: String,
    val origin: Vec3i,
    val size: Vec3i,
    val palette: List<BlockState>,
) {
    /** Positions, air included. The block count is only known after a pass over the data. */
    val volume: Long get() = size.x.toLong() * size.y * size.z

    /** Palette entries that mean nothing is there, resolved once rather than per position. */
    val airIndices: Set<Int> =
        palette.withIndex().filter { it.value.isAir }.map { it.index }.toSet()
}

/**
 * Everything about a schematic except its blocks: enough to size the work, allocate the occupancy
 * index and draw the bounding box, and cheap enough to keep in a row.
 */
data class SchematicInfo(
    val format: SchematicFormat,
    val dataVersion: Int,
    val regions: List<RegionInfo>,
) {
    val volume: Long get() = regions.sumOf(RegionInfo::volume)

    /** The box containing every region, which is what the operator places and rotates. */
    val bounds: Pair<Vec3i, Vec3i>
        get() {
            val min = Vec3i(
                regions.minOf { it.origin.x },
                regions.minOf { it.origin.y },
                regions.minOf { it.origin.z },
            )
            val max = Vec3i(
                regions.maxOf { it.origin.x + it.size.x },
                regions.maxOf { it.origin.y + it.size.y },
                regions.maxOf { it.origin.z + it.size.z },
            )
            return min to max
        }
}

/**
 * Where the blocks go as they are read.
 *
 * Called once per **non-air** block, in build order — bottom layer first, and within a layer in a
 * fixed order. Air is dropped by the reader rather than passed on: it is most of a schematic by
 * count, and a consumer that has to filter it is a consumer paying for the whole volume rather than
 * the part that gets built.
 *
 * The order is not incidental. It is what lets a segment be described as a range rather than a set,
 * and what lets progress be a single number.
 */
fun interface BlockSink {
    fun place(region: Int, x: Int, y: Int, z: Int, state: Int)
}

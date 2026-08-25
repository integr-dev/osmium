package net.integr.osmium.schematic

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

/**
 * One segment's blocks, on the wire.
 *
 * A host is handed the blocks it is to place, already resolved: the schematic decoded, the job's
 * substitutions applied, and anything substituted away simply absent. It places what it is given and
 * decodes nothing. The alternative — serving the file and letting the host read it — means two
 * decoders agreeing forever on palette quirks, negative Litematica extents and what counts as air,
 * which is a bargain nobody should take twice.
 *
 * **Fixed-width records rather than varints.** Positions are monotonic, so their high bytes barely
 * change and gzip on the wire recovers most of what a delta encoding would have saved. What is left
 * is a format the host reads with a six-byte stride: no varint state machine, no framing ambiguity,
 * and a hexdump somebody can check by eye. The version byte is the escape hatch if measurement ever
 * says otherwise.
 *
 * **Not the dense grid the file formats use.** The split balances *blocks*, not volume, so a sparse
 * region is handed a large box — and a grid costs its volume whether anything is in it or not,
 * punishing exactly the segments the splitter makes big.
 *
 * ```
 * "OSM1"                     magic and version
 * u16                        palette entries
 *   u16 length, UTF-8        each block name
 * i32 x3                     box minimum, world coordinates
 * u32 x3                     box size (dx, dy, dz)
 * u32                        block count
 *   u32 linear, u16 palette  each block, ascending
 * ```
 *
 * Big-endian throughout. `linear = ((y * dz) + z) * dx + x`, measured from the box minimum — the
 * y-then-z-then-x order both decoders read in, so a host walking the stream is already in build
 * order and never computes a position twice.
 */
object SegmentBlocks {

    const val MAGIC = "OSM1"

    /** `application/octet-stream` would do; naming it says what a body is without opening it. */
    const val CONTENT_TYPE = "application/vnd.osmium.segment"

    /**
     * The largest box a segment may describe.
     *
     * A `u32` linear index runs out at a box of 1626 cubed, which is far past anything Minecraft can
     * hold — its height alone caps at 384 — so this is a limit that says the format is finite rather
     * than one anybody meets. Refused rather than wrapped: an index that silently rolls over places
     * blocks somewhere nobody asked for.
     */
    const val MAX_POSITIONS = 0xFFFF_FFFFL

    /**
     * Packs a block into one long, position above material.
     *
     * Sorting the packed values *is* sorting by position, so ordering a segment is one call to
     * [java.util.Arrays.sort] over primitives rather than a comparator over a few million objects.
     */
    fun pack(linear: Long, palette: Int): Long = (linear shl 16) or palette.toLong()

    fun linearOf(packed: Long): Long = packed ushr 16

    fun paletteOf(packed: Long): Int = (packed and 0xFFFF).toInt()

    /**
     * @param blocks packed by [pack] and **sorted ascending**, which the caller does with a
     *   primitive sort rather than this walking them into order itself.
     */
    fun encode(
        min: Vec3i,
        size: Vec3i,
        palette: List<String>,
        blocks: LongArray,
        count: Int = blocks.size,
    ): ByteArray {
        require(palette.size <= MAX_PALETTE) {
            "A segment has ${palette.size} materials, past the ${MAX_PALETTE} this format can name"
        }

        val out = ByteArrayOutputStream(HEADER_GUESS + count * RECORD_BYTES)
        val data = DataOutputStream(out)

        data.writeBytes(MAGIC)

        data.writeShort(palette.size)
        palette.forEach { name ->
            val bytes = name.toByteArray(Charsets.UTF_8)
            require(bytes.size <= MAX_NAME_BYTES) { "Block name '$name' is too long to send" }
            data.writeShort(bytes.size)
            data.write(bytes)
        }

        data.writeInt(min.x)
        data.writeInt(min.y)
        data.writeInt(min.z)
        data.writeInt(size.x)
        data.writeInt(size.y)
        data.writeInt(size.z)

        data.writeInt(count)
        for (index in 0 until count) {
            val packed = blocks[index]
            // `writeInt` takes the low 32 bits, which is exactly the unsigned index: a position past
            // 2^31 arrives as a negative Int here and as the right u32 on the wire.
            data.writeInt(linearOf(packed).toInt())
            data.writeShort(paletteOf(packed))
        }

        data.flush()
        return out.toByteArray()
    }

    /** Where a world coordinate lands in the stream's order, or null when it is outside the box. */
    fun linearOf(x: Int, y: Int, z: Int, min: Vec3i, size: Vec3i): Long? {
        val dx = x - min.x
        val dy = y - min.y
        val dz = z - min.z

        if (dx < 0 || dy < 0 || dz < 0) return null
        if (dx >= size.x || dy >= size.y || dz >= size.z) return null

        return (dy.toLong() * size.z + dz) * size.x + dx
    }

    /** Positions in a box, which is what [MAX_POSITIONS] bounds. */
    fun positionsIn(size: Vec3i): Long = size.x.toLong() * size.y * size.z

    const val MAX_PALETTE = 0xFFFF
    private const val MAX_NAME_BYTES = 0xFFFF
    private const val RECORD_BYTES = 6
    private const val HEADER_GUESS = 512
}

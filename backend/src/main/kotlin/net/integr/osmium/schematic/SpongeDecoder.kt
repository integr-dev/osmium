package net.integr.osmium.schematic

import net.integr.osmium.schematic.nbt.NbtFormatException
import net.integr.osmium.schematic.nbt.NbtInput
import net.integr.osmium.schematic.nbt.NbtType
import org.springframework.stereotype.Component
import java.io.InputStream

/**
 * Sponge's `.schem`, versions 2 and 3.
 *
 * One region, palette indices as varints rather than packed bits, and a palette written as single
 * strings — `minecraft:oak_stairs[facing=east]` — rather than as a name beside a properties
 * compound.
 *
 * **This format has a ceiling.** Its block data is one NBT byte array for the whole file, and an
 * NBT array length is a signed 32-bit int, so the data cannot exceed about 2.1 billion bytes — one
 * to five per position. A build past a couple of billion positions cannot be written as a `.schem`
 * at all, whoever is writing it. Litematica gets further only because its data is per region.
 *
 * The two versions differ by nesting, not by content: version 3 moved the body under a `Schematic`
 * tag and the blocks under a `Blocks` tag. Both are read by descending into those two names
 * wherever they appear, which handles either layout without a version switch. Deliberately not
 * `Biomes`, which carries a `Palette` and a `Data` of its own and would otherwise overwrite the
 * blocks with terrain.
 */
@Component
class SpongeDecoder : SchematicDecoder {

    override val format = SchematicFormat.SPONGE

    override fun recognises(root: Set<String>) =
        "Schematic" in root || "BlockData" in root || "PaletteMax" in root

    override fun readInfo(source: InputStream): SchematicInfo {
        NbtInput(NbtInput.open(source)).use { input ->
            input.beginCompound()

            val body = Body()
            input.readBody(body)

            if (body.width <= 0 || body.height <= 0 || body.length <= 0) {
                throw NbtFormatException(
                    "The file measures ${body.width}x${body.height}x${body.length}"
                )
            }
            val palette = body.palette ?: throw NbtFormatException("The file has no palette")

            return SchematicInfo(
                format = format,
                dataVersion = body.dataVersion,
                regions = listOf(
                    RegionInfo(
                        // The format has no name for its single region, and every message about
                        // one reads better with a word than with an empty string.
                        name = "schematic",
                        origin = body.offset,
                        size = Vec3i(body.width, body.height, body.length),
                        palette = palette,
                    )
                ),
            )
        }
    }

    override fun readBlocks(source: InputStream, info: SchematicInfo, sink: BlockSink) {
        val region = info.regions.single()

        NbtInput(NbtInput.open(source)).use { input ->
            input.beginCompound()
            if (!input.seekBlockData()) throw NbtFormatException("The file has no block data")

            val declared = input.beginArray()
            val data = VarIntArray(input, declared)

            val (originX, originY, originZ) = region.origin
            val (sizeX, sizeY, sizeZ) = region.size
            val air = region.airIndices
            val states = region.palette.size

            // `x + z * width + y * width * length`, which is y outermost, then z, then x — the same
            // order Litematica uses, so build order is one rule across both formats.
            for (y in 0 until sizeY) {
                for (z in 0 until sizeZ) {
                    for (x in 0 until sizeX) {
                        val state = data.next()
                        if (state >= states) {
                            throw NbtFormatException("Block data names palette entry $state of $states")
                        }
                        if (state in air) continue
                        sink.place(0, originX + x, originY + y, originZ + z, state)
                    }
                }
            }

            data.drain()
        }
    }

    /** What [readInfo] gathers, from whichever depth the file's version put it at. */
    private class Body {
        var dataVersion = 0
        var width = 0
        var height = 0
        var length = 0
        var offset = Vec3i(0, 0, 0)
        var palette: List<BlockState>? = null
    }

    private fun NbtInput.readBody(body: Body) {
        while (true) {
            val field = nextField() ?: return
            when (field.name) {
                // Version 3's two extra levels. Descending into them rather than branching on the
                // version means one reader for both, and an unknown future nesting fails by
                // finding nothing rather than by decoding the wrong tag.
                "Schematic", "Blocks" ->
                    if (field.type == NbtType.COMPOUND) readBody(body) else skipValue(field.type)

                "DataVersion" -> body.dataVersion = readInt()
                // Unsigned: the format stores dimensions as shorts, and a build 40,000 blocks
                // across reads as negative if the sign is believed.
                "Width" -> body.width = readShort().toInt() and 0xFFFF
                "Height" -> body.height = readShort().toInt() and 0xFFFF
                "Length" -> body.length = readShort().toInt() and 0xFFFF
                "Offset" -> body.offset = readOffset()
                "Palette" -> body.palette = readPalette()
                else -> skipValue(field.type)
            }
        }
    }

    /** The schematic's minimum corner, as an `int[3]`. Absent in files that were never moved. */
    private fun NbtInput.readOffset(): Vec3i {
        val length = beginArray()
        if (length != 3) {
            repeat(length) { readInt() }
            return Vec3i(0, 0, 0)
        }
        return Vec3i(readInt(), readInt(), readInt())
    }

    /**
     * The palette, which is a compound of `state -> index` rather than a list in index order — so
     * it arrives unordered and has to be placed.
     */
    private fun NbtInput.readPalette(): List<BlockState> {
        val byIndex = HashMap<Int, BlockState>()
        while (true) {
            val field = nextField() ?: break
            if (field.type != NbtType.INT) {
                skipValue(field.type)
                continue
            }
            val index = readInt()
            if (index < 0) throw NbtFormatException("Palette entry '${field.name}' has index $index")
            byIndex[index] = BlockState.parse(field.name)
        }

        if (byIndex.isEmpty()) throw NbtFormatException("The file has an empty palette")

        val size = byIndex.keys.max() + 1
        // A gap means the palette does not define an index the data is free to name. Refused here
        // rather than resolved to air, because resolving it silently deletes blocks.
        return (0 until size).map {
            byIndex[it] ?: throw NbtFormatException("The palette does not define index $it")
        }
    }

    /** Walks to the block data, descending version 3's nesting on the way. Leaves it unread. */
    private fun NbtInput.seekBlockData(): Boolean {
        while (true) {
            val field = nextField() ?: return false
            when {
                field.name == "BlockData" || field.name == "Data" -> return true
                field.name == "Schematic" || field.name == "Blocks" -> {
                    if (field.type == NbtType.COMPOUND && seekBlockData()) return true
                }

                else -> skipValue(field.type)
            }
        }
    }

    /**
     * Varints out of a byte array, pulled a window at a time.
     *
     * The array is the whole build, so it is never held. The window is what makes that affordable:
     * a varint is one to five bytes and reading them one at a time from the stream would be a call
     * per byte over billions of them.
     */
    private class VarIntArray(private val input: NbtInput, private val declared: Int) {
        private val window = ByteArray(minOf(declared.toLong(), WINDOW).toInt().coerceAtLeast(1))
        private var position = 0
        private var limit = 0

        /** Bytes taken from the stream, which runs ahead of the bytes handed out. */
        private var read = 0

        fun next(): Int {
            var value = 0
            var shift = 0
            while (true) {
                val byte = byte()
                value = value or ((byte and 0x7F) shl shift)
                if (byte and 0x80 == 0) return value
                shift += 7
                // Five bytes is the most a 32-bit varint can take. More than that is a corrupt
                // array, and left unchecked it shifts off the end and returns a plausible index.
                if (shift > 28) throw NbtFormatException("Malformed varint in block data")
            }
        }

        /**
         * Consumes whatever is left of the array. The data may be longer than the positions
         * encoded in it, and an array left part-read ends inside itself — every tag after it is
         * then read from the wrong offset.
         */
        fun drain() {
            val remaining = declared.toLong() - read
            if (remaining > 0) input.skipBytes(remaining)
        }

        private fun byte(): Int {
            if (position == limit) fill()
            return window[position++].toInt() and 0xFF
        }

        private fun fill() {
            val want = minOf(window.size, declared - read)
            if (want <= 0) throw NbtFormatException("Block data ended before the build did")
            input.readBytes(window, 0, want)
            read += want
            position = 0
            limit = want
        }

        companion object {
            private const val WINDOW = 64L * 1024
        }
    }
}

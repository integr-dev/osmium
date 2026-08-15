package net.integr.osmium.schematic

import net.integr.osmium.schematic.nbt.NbtWriter

/**
 * Builds schematic files for the tests to read.
 *
 * There are no `.litematic` files checked into this repository and there should not be: one large
 * enough to exercise the reader is one too large to keep in version control, and one small enough
 * to keep proves nothing about the size that motivates the design. Building them here also lets a
 * test state the awkward thing it is about — a negative extent, a palette that crosses a bit
 * boundary, a declared length that disagrees with the data — rather than hunting for a file that
 * happens to contain it.
 */
object SchematicFixtures {

    /**
     * A region as a test writes it. [states] are palette indices in the format's own order:
     * y outermost, then z, then x.
     */
    data class Region(
        val name: String,
        val position: Vec3i,
        val size: Vec3i,
        val palette: List<String>,
        val states: IntArray,
    )

    fun region(
        name: String = "main",
        position: Vec3i = Vec3i(0, 0, 0),
        size: Vec3i,
        palette: List<String>,
        states: IntArray,
    ) = Region(name, position, size, palette, states)

    fun litematic(
        regions: List<Region>,
        dataVersion: Int = SUPPORTED_DATA_VERSION,
        compressed: Boolean = true,
    ): ByteArray {
        val body: NbtWriter.() -> Unit = {
            int("Version", 6)
            int("MinecraftDataVersion", dataVersion)
            compound("Metadata") {
                string("Name", "fixture")
                int("RegionCount", regions.size)
            }
            compound("Regions") {
                regions.forEach { region ->
                    compound(region.name) {
                        compound("Position") {
                            int("x", region.position.x)
                            int("y", region.position.y)
                            int("z", region.position.z)
                        }
                        compound("Size") {
                            int("x", region.size.x)
                            int("y", region.size.y)
                            int("z", region.size.z)
                        }
                        compoundList("BlockStatePalette", region.palette.size) { index ->
                            val state = BlockState.parse(region.palette[index])
                            string("Name", state.name)
                            if (state.properties.isNotEmpty()) {
                                compound("Properties") {
                                    state.properties.forEach { (key, value) -> string(key, value) }
                                }
                            }
                        }
                        longArray(
                            "BlockStates",
                            pack(PackedEntries.bitsFor(region.palette.size), region.states),
                        )
                        // Written because real files have them and the reader must skip them to
                        // land on the next region.
                        emptyList("TileEntities")
                        emptyList("Entities")
                    }
                }
            }
        }

        return if (compressed) NbtWriter.gzipped(body = body) else NbtWriter.document(body = body)
    }

    /**
     * A Sponge `.schem`. Version 3 nests the body under `Schematic` and the blocks under `Blocks`;
     * version 2 puts both at the root. Same content either way, which is the point of writing both.
     */
    fun sponge(
        region: Region,
        version: Int = 3,
        dataVersion: Int = SUPPORTED_DATA_VERSION,
        compressed: Boolean = true,
        trailingData: Int = 0,
    ): ByteArray {
        val palette: NbtWriter.() -> Unit = {
            compound("Palette") {
                region.palette.forEachIndexed { index, state -> int(state, index) }
            }
        }
        val dimensions: NbtWriter.() -> Unit = {
            int("DataVersion", dataVersion)
            short("Width", region.size.x)
            short("Height", region.size.y)
            short("Length", region.size.z)
            intArray(
                "Offset",
                intArrayOf(region.position.x, region.position.y, region.position.z),
            )
        }
        val data = varints(region.states) + ByteArray(trailingData)

        val body: NbtWriter.() -> Unit = {
            if (version >= 3) {
                compound("Schematic") {
                    int("Version", version)
                    dimensions()
                    compound("Blocks") {
                        palette()
                        byteArray("Data", data)
                    }
                }
            } else {
                int("Version", version)
                dimensions()
                int("PaletteMax", region.palette.size)
                palette()
                byteArray("BlockData", data)
            }
        }

        return if (compressed) NbtWriter.gzipped(body = body) else NbtWriter.document(body = body)
    }

    /** LEB128, as the format encodes palette indices. */
    fun varints(values: IntArray): ByteArray {
        val out = ArrayList<Byte>(values.size)
        values.forEach { value ->
            var rest = value
            while (true) {
                val byte = rest and 0x7F
                rest = rest ushr 7
                if (rest == 0) {
                    out += byte.toByte()
                    break
                }
                out += (byte or 0x80).toByte()
            }
        }
        return out.toByteArray()
    }

    /**
     * The format's packing, straddling long boundaries as it does. Deliberately a separate
     * implementation from the one in `PackedEntriesTest`: that one exists to check the decoder
     * against an independent encoder, and sharing it would make the round trip prove nothing.
     */
    fun pack(bits: Int, values: IntArray): LongArray {
        val longs = LongArray(((values.size.toLong() * bits + 63) / 64).toInt())
        for (index in values.indices) {
            val startBit = index.toLong() * bits
            val start = (startBit ushr 6).toInt()
            val end = ((startBit + bits - 1) ushr 6).toInt()
            val offset = (startBit and 63L).toInt()

            longs[start] = longs[start] or (values[index].toLong() shl offset)
            if (start != end) longs[end] = longs[end] or (values[index].toLong() ushr (64 - offset))
        }
        return longs
    }

    /** Collects what a decoder emits, so a test can state the whole expected sequence. */
    class Recorder : BlockSink {
        val placed = mutableListOf<Placed>()

        override fun place(region: Int, x: Int, y: Int, z: Int, state: Int) {
            placed += Placed(region, x, y, z, state)
        }
    }

    data class Placed(val region: Int, val x: Int, val y: Int, val z: Int, val state: Int)

    /** Java Edition 26.2, which is what the gate accepts by default. */
    const val SUPPORTED_DATA_VERSION = 4903
}

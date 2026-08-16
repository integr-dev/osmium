package net.integr.osmium.schematic

import net.integr.osmium.schematic.nbt.NbtFormatException
import net.integr.osmium.schematic.nbt.NbtInput
import net.integr.osmium.schematic.nbt.NbtType
import org.springframework.stereotype.Component
import java.io.InputStream
import kotlin.math.abs

/**
 * Litematica's `.litematic`.
 *
 * The format that matters most here, because it is the only one of the two that can express the
 * sizes Osmium accepts: its block data is per region rather than per file, so the signed 32-bit
 * ceiling on an NBT array applies to each region separately and a large build is simply several of
 * them. Multi-region handling is therefore the main path, not an edge case.
 *
 * Two things about it are easy to get wrong and produce a file that still reads:
 *
 * - **Block indices straddle long boundaries.** See [PackedEntries].
 * - **A region's extent may be negative**, meaning it runs backwards from its stated position. The
 *   position is then not the minimum corner, and treating it as one mirrors the build about that
 *   axis — every block present, none of them where they belong. Normalised here, so nothing
 *   downstream carries the rule.
 */
@Component
class LitematicDecoder : SchematicDecoder {

    override val format = SchematicFormat.LITEMATIC

    override fun recognises(root: Set<String>) = "Regions" in root

    override fun readInfo(source: InputStream): SchematicInfo {
        NbtInput(NbtInput.open(source)).use { input ->
            input.beginCompound()

            var dataVersion: Int? = null
            var regions: List<RegionInfo>? = null

            while (true) {
                val field = input.nextField() ?: break
                when (field.name) {
                    "MinecraftDataVersion" -> dataVersion = input.readInt()
                    "Regions" -> regions = input.readRegions()
                    else -> input.skipValue(field.type)
                }
                if (dataVersion != null && regions != null) break
            }

            if (regions.isNullOrEmpty()) throw NbtFormatException("The file declares no regions")

            return SchematicInfo(
                format = format,
                // Absent in files written before Litematica recorded it. Reported as 0 rather than
                // guessed, and refused upstream — a schematic whose version is unknown is exactly
                // the one that should not be built from.
                dataVersion = dataVersion ?: 0,
                regions = regions,
            )
        }
    }

    override fun readBlocks(source: InputStream, info: SchematicInfo, sink: BlockSink) {
        NbtInput(NbtInput.open(source)).use { input ->
            input.beginCompound()
            if (input.seek("Regions") == null) throw NbtFormatException("The file declares no regions")

            var index = 0
            while (true) {
                val field = input.nextField() ?: break
                if (field.type != NbtType.COMPOUND) {
                    input.skipValue(field.type)
                    continue
                }

                val region = info.regions.getOrNull(index)
                    ?: throw NbtFormatException("More regions than the first pass found")
                if (region.name != field.name) {
                    // The two passes read the same file, so the regions must arrive in the same
                    // order. If they have not, the palettes belong to different regions than the
                    // block data does, and every block would decode to a plausible wrong state.
                    throw NbtFormatException(
                        "Region ${index + 1} is '${field.name}', was '${region.name}'"
                    )
                }

                input.readRegionBlocks(region, index, sink)
                index += 1
            }

            if (index != info.regions.size) {
                throw NbtFormatException("Fewer regions than the first pass found")
            }
        }
    }

    private fun NbtInput.readRegions(): List<RegionInfo> = buildList {
        while (true) {
            val field = nextField() ?: return@buildList
            if (field.type != NbtType.COMPOUND) {
                skipValue(field.type)
                continue
            }
            add(readRegion(field.name))
        }
    }

    private fun NbtInput.readRegion(name: String): RegionInfo {
        var position: Vec3i? = null
        var size: Vec3i? = null
        var palette: List<BlockState>? = null

        while (true) {
            val field = nextField() ?: break
            when (field.name) {
                "Position" -> position = readVec3i()
                "Size" -> size = readVec3i()
                "BlockStatePalette" -> palette = readPalette()
                else -> skipValue(field.type)
            }
        }

        if (position == null || size == null) {
            throw NbtFormatException("Region '$name' has no position or no size")
        }
        if (palette.isNullOrEmpty()) throw NbtFormatException("Region '$name' has no palette")
        if (size.x == 0 || size.y == 0 || size.z == 0) {
            throw NbtFormatException("Region '$name' is empty in at least one axis")
        }

        return RegionInfo(
            name = name,
            origin = Vec3i(
                minimumCorner(position.x, size.x),
                minimumCorner(position.y, size.y),
                minimumCorner(position.z, size.z),
            ),
            size = Vec3i(abs(size.x), abs(size.y), abs(size.z)),
            palette = palette,
        )
    }

    /**
     * The lower of the two corners the region spans on one axis.
     *
     * A negative extent means the region runs *back* from its position, and the last block is at
     * `position + extent + 1` — the `+ 1` because both ends are inclusive. Off by that one and the
     * whole region is a block out along that axis.
     */
    private fun minimumCorner(position: Int, extent: Int): Int =
        if (extent < 0) position + extent + 1 else position

    private fun NbtInput.readPalette(): List<BlockState> {
        val list = beginList()
        if (list.length == 0) return emptyList()
        if (list.elementType != NbtType.COMPOUND) {
            throw NbtFormatException("A palette of ${list.elementType} is not a palette")
        }

        return (0 until list.length).map {
            var name: String? = null
            var properties = emptyMap<String, String>()
            while (true) {
                val field = nextField() ?: break
                when (field.name) {
                    "Name" -> name = readString()
                    "Properties" -> properties = readStringMap()
                    else -> skipValue(field.type)
                }
            }
            BlockState(name ?: throw NbtFormatException("A palette entry has no name"), properties)
        }
    }

    private fun NbtInput.readRegionBlocks(region: RegionInfo, index: Int, sink: BlockSink) {
        if (seek("BlockStates") == null) {
            throw NbtFormatException("Region '${region.name}' has no block data")
        }

        val bits = PackedEntries.bitsFor(region.palette.size)
        val entries = PackedEntries(bits, region.volume) { readLong() }

        val declared = beginArray().toLong()
        if (declared != entries.expectedLongs()) {
            // Header and payload disagreeing is not recoverable: reading `declared` longs leaves
            // the region short or long, and either way the next region starts mid-value.
            throw NbtFormatException(
                "Region '${region.name}' declares $declared longs, its size needs ${entries.expectedLongs()}"
            )
        }

        val (originX, originY, originZ) = region.origin
        val (sizeX, sizeY, sizeZ) = region.size
        val air = region.airIndices

        // The format's own order: y outermost, then z, then x. Kept exactly, because it is what
        // makes build order deterministic — and a deterministic order is what lets a segment be a
        // range and progress be one number.
        for (y in 0 until sizeY) {
            for (z in 0 until sizeZ) {
                for (x in 0 until sizeX) {
                    val state = entries.next()
                    if (state in air) continue
                    sink.place(index, originX + x, originY + y, originZ + z, state)
                }
            }
        }

        // The array is consumed exactly, so the stream is left on the tag after it and the rest of
        // the region — tile entities, entities, pending ticks — can be skipped normally.
        skipRest()
    }
}

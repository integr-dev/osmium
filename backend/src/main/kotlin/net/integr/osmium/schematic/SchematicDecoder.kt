package net.integr.osmium.schematic

import net.integr.osmium.schematic.nbt.NbtInput
import net.integr.osmium.schematic.nbt.NbtType
import java.io.InputStream

/**
 * Reads one schematic format.
 *
 * **Two passes, deliberately.** A file states its palette and its block data as separate tags of an
 * unordered compound, so a writer is free to put the data first — and when it does, a single pass
 * has no way to tell which palette index means air until it has already streamed past the blocks.
 * Buffering the data instead is exactly the thing that cannot be done at these sizes.
 *
 * The second pass is not free: the file is gzipped, and there is no seeking inside a gzip stream,
 * so skipping a tag still costs its decompression. Two passes therefore cost two decompressions.
 * That is a real price, paid once per upload in a background job, in exchange for a reader that
 * cannot be defeated by tag order.
 */
interface SchematicDecoder {
    val format: SchematicFormat

    /** True when this decoder recognises the file, judged from its root tags. */
    fun recognises(root: Set<String>): Boolean

    /** Everything but the blocks: sizes, palettes, the data version. */
    fun readInfo(source: InputStream): SchematicInfo

    /** Every non-air block, in build order, to `sink`. */
    fun readBlocks(source: InputStream, info: SchematicInfo, sink: BlockSink)
}

/** Walks the current compound to the named field, skipping what comes before. Null if absent. */
internal fun NbtInput.seek(name: String): NbtType? {
    while (true) {
        val field = nextField() ?: return null
        if (field.name == name) return field.type
        skipValue(field.type)
    }
}

/** Reads an `{x, y, z}` compound, whatever order the three arrive in. */
internal fun NbtInput.readVec3i(): Vec3i {
    var x = 0
    var y = 0
    var z = 0
    while (true) {
        val field = nextField() ?: return Vec3i(x, y, z)
        when (field.name) {
            "x" -> x = readInt()
            "y" -> y = readInt()
            "z" -> z = readInt()
            else -> skipValue(field.type)
        }
    }
}

/** Reads a compound of `key -> string`, which is how block state properties are written. */
internal fun NbtInput.readStringMap(): Map<String, String> = buildMap {
    while (true) {
        val field = nextField() ?: return@buildMap
        if (field.type == NbtType.STRING) put(field.name, readString()) else skipValue(field.type)
    }
}

/** Skips the rest of the compound being read, leaving the stream on the tag after it. */
internal fun NbtInput.skipRest() {
    while (true) {
        val field = nextField() ?: return
        skipValue(field.type)
    }
}

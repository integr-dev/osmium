package net.integr.osmium.schematic

import net.integr.osmium.schematic.config.SchematicProperties
import net.integr.osmium.schematic.nbt.NbtFormatException
import net.integr.osmium.schematic.nbt.NbtInput
import org.springframework.stereotype.Component
import java.io.InputStream

/** A schematic Osmium can read, but not from a version it can build. */
class UnsupportedVersionException(message: String) : RuntimeException(message)

/**
 * Reading a schematic without being told what it is.
 *
 * Format is decided from the file rather than from its name: an extension is whatever the operator
 * typed, and both of these are NBT underneath, so the file itself is the only thing that knows.
 *
 * Each call opens the source again, which is why this takes a factory rather than a stream. There
 * is no seeking inside a gzip stream, so a second read cannot rewind — and the reads are genuinely
 * separate passes. See [SchematicDecoder] for why there are two of them.
 */
@Component
class SchematicFiles(
    private val decoders: List<SchematicDecoder>,
    private val properties: SchematicProperties,
) {

    /**
     * Identifies the file, reads everything but its blocks, and refuses it if it comes from a
     * version this Osmium does not build.
     */
    fun open(source: () -> InputStream): SchematicInfo {
        val decoder = detect(source())
        val info = decoder.readInfo(source())
        requireSupported(info)
        return info
    }

    /** Streams every non-air block of an already-opened schematic, in build order. */
    fun readBlocks(source: () -> InputStream, info: SchematicInfo, sink: BlockSink) {
        decoderFor(info.format).readBlocks(source(), info, sink)
    }

    /**
     * Decides the format from the root tags.
     *
     * Cheap in practice despite reading a compressed file: the tag that settles it is checked as
     * soon as its *name* has been read, before its value. That matters — the decisive tag in a
     * litematic is `Regions`, which holds the entire build, and a detector that skipped past it
     * would decompress the whole file to learn something it already knew.
     */
    fun detect(source: InputStream): SchematicDecoder {
        NbtInput(NbtInput.open(source)).use { input ->
            input.beginCompound()

            val seen = mutableSetOf<String>()
            while (true) {
                val field = input.nextField() ?: break
                seen += field.name

                decoders.firstOrNull { it.recognises(seen) }?.let { return it }
                input.skipValue(field.type)
            }

            if (isLegacy(seen)) throw NbtFormatException(LEGACY_MESSAGE)
        }

        throw NbtFormatException(
            "The file is NBT but neither a litematic nor a schem — no format's tags are in it"
        )
    }

    /**
     * MCEdit's `.schematic`, which is a different format that happens to share an extension with
     * files people rename.
     *
     * Named rather than lumped in with "unrecognised", because it is the one unsupported format an
     * operator is likely to have and the only one they can do something about: converting it is a
     * menu item in the tools they already use. Told it is merely unrecognised, they would reasonably
     * conclude the file is broken.
     *
     * Supporting it is not a decoder. It stores blocks as **numeric ids with a data nibble** —
     * `1` is stone, `5:2` is birch planks — so reading it means carrying the whole pre-flattening
     * mapping to modern block names, some four thousand entries of it. Nothing else here would use
     * that table.
     */
    private fun isLegacy(root: Set<String>): Boolean =
        "Materials" in root || ("Blocks" in root && "Data" in root)

    private fun decoderFor(format: SchematicFormat): SchematicDecoder =
        decoders.first { it.format == format }

    private companion object {
        const val LEGACY_MESSAGE =
            "This is an MCEdit .schematic from Minecraft 1.12 or earlier, which stores blocks as " +
                "numeric ids rather than names. Open it in Litematica or WorldEdit and save it as " +
                ".litematic or .schem."
    }

    /**
     * A range rather than one version, because most blocks do not change: stone from 1.16 is stone
     * in 26.2, and refusing a build for being old would refuse most of the builds anyone has.
     *
     * What the range cannot do is promise the file *works*. Some blocks were renamed, and nothing
     * here resolves a block name against a registry — so a name that no longer exists is
     * indistinguishable from one that does, and the failure lands on the host at build time. The
     * ends are what can be checked: below the floor a file does not name its blocks at all, and
     * above the ceiling it names blocks the fleet's Minecraft does not have.
     */
    private fun requireSupported(info: SchematicInfo) {
        if (properties.accepts(info.dataVersion)) return

        // Naming all three numbers, because the operator's next question is which version their
        // file is from and no other part of the system will tell them.
        throw UnsupportedVersionException(
            "The schematic was saved from Minecraft data version ${info.dataVersion}, " +
                "and this Osmium builds ${properties.minDataVersion} to ${properties.maxDataVersion}"
        )
    }
}

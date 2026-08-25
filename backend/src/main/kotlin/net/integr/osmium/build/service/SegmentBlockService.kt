package net.integr.osmium.build.service

import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildSegment
import net.integr.osmium.schematic.SchematicFiles
import net.integr.osmium.schematic.SegmentBlocks
import net.integr.osmium.schematic.Vec3i
import net.integr.osmium.schematic.service.SchematicStorage
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.Arrays

/**
 * Reads one segment's blocks out of the schematic behind it.
 *
 * **Nothing per-block is stored anywhere**, deliberately: a pass over a schematic leaves a count per
 * cell and a material list, because a billion rows is not a table. So a segment is produced by
 * reading the file again and keeping what falls inside one box — which is affordable because the
 * decoder streams, drops air as it goes, and a segment is a fraction of a file.
 *
 * On demand rather than materialised at dispatch. Writing a blob per segment when a job starts would
 * turn each fetch into a file read, at the cost of roughly the build's own size in disk and a
 * lifecycle to keep in step with jobs that get reassigned, paused and deleted. This costs one
 * decompression per fetch and nothing at rest; it becomes worth caching when something measures it,
 * and not before.
 */
@Service
@Transactional(readOnly = true)
class SegmentBlockService(
    private val files: SchematicFiles,
    private val storage: SchematicStorage,
) {

    /**
     * The segment, resolved and encoded.
     *
     * Three things happen in the one pass: the box is applied, the job's **frozen** substitutions
     * are applied, and anything substituted to nothing is dropped rather than sent as a hole for the
     * host to interpret.
     */
    fun encode(job: BuildJob, segment: BuildSegment): ByteArray {
        val schematic = job.schematic
        val id = checkNotNull(schematic.id) { "Job has no schematic" }

        check(storage.exists(id)) { "The file for '${schematic.name}' is missing from storage" }

        val min = Vec3i(segment.minX, segment.minY, segment.minZ)
        val size = Vec3i(
            segment.maxX - segment.minX,
            segment.maxY - segment.minY,
            segment.maxZ - segment.minZ,
        )

        val positions = SegmentBlocks.positionsIn(size)
        check(positions <= SegmentBlocks.MAX_POSITIONS) {
            "Segment ${segment.ordinal} spans $positions positions, past what this format can index"
        }

        val info = files.open { storage.open(id) }

        // A placement anchors the schematic's minimum corner, and the file carries its own origin,
        // so the difference is what moves a block into the world. The job pinned both, which is what
        // makes a segment fetched now describe the same blocks as when it was handed out.
        val origin = info.bounds.first
        val offsetX = job.placeX - origin.x
        val offsetY = job.placeY - origin.y
        val offsetZ = job.placeZ - origin.z

        val rules = job.substitutions.associate { blockId(it.from) to it.to?.let(::blockId) }

        // What each palette entry becomes, resolved once per entry rather than once per block: a
        // region names a few dozen materials and places millions of them. Null is a block the plan
        // substitutes away, which is left out rather than sent as a hole for the host to interpret.
        val resolved = info.regions.map { region ->
            region.palette.map { state ->
                val id = blockId(state.name)
                if (id in rules) rules[id] else state.name
            }
        }

        // **Interned when a block is actually emitted, not when its entry is read.** Doing it eagerly
        // put every material the *file* names into the palette a host is handed — air included, and
        // anything whose every instance falls in another segment. The palette should describe this
        // segment.
        val names = mutableListOf<String>()
        val indices = HashMap<String, Int>()
        val interned = info.regions.map { IntArray(it.palette.size) { UNRESOLVED } }

        val blocks = PackedBlocks()

        files.readBlocks({ storage.open(id) }, info) { region, x, y, z, state ->
            val material = resolved[region][state] ?: return@readBlocks

            val linear = SegmentBlocks.linearOf(x + offsetX, y + offsetY, z + offsetZ, min, size)
                ?: return@readBlocks

            var index = interned[region][state]
            if (index == UNRESOLVED) {
                index = indices.getOrPut(material) { names.size.also { names += material } }
                interned[region][state] = index
            }

            blocks.add(SegmentBlocks.pack(linear, index))
        }

        // Sorted here rather than relied upon. Within one region the reader is already ascending —
        // y, then z, then x — but a Litematica file holds several and they are read one after
        // another, so a later region can describe positions earlier in the box. The host gets a
        // guarantee instead of a caveat.
        Arrays.sort(blocks.values, 0, blocks.size)

        return SegmentBlocks.encode(min, size, names, blocks.values, blocks.size)
    }

    /**
     * A block name with Minecraft's own namespace stripped, matching how a plan stores its rules.
     *
     * `minecraft:stone` and `stone` are the same block, and the two spellings reach here from
     * different places: a file's palette carries the namespace, the block picker does not. Comparing
     * as written is how a rule silently applied to nothing — twice, now, in this codebase.
     */
    private fun blockId(name: String): String = name.trim().removePrefix("minecraft:")

    private companion object {
        /** No output index yet, which is not the same as index zero. */
        const val UNRESOLVED = -1
    }
}

/**
 * A growable array of packed blocks, kept primitive.
 *
 * A segment of a large build runs to millions, and a `List<Long>` boxes every one of them — a few
 * hundred megabytes of objects to hold something that is sixteen bytes of arithmetic. The rest of
 * the schematic subsystem is built around what is affordable at these sizes; this is the same rule
 * one level down.
 */
private class PackedBlocks {
    var values = LongArray(INITIAL)
        private set
    var size = 0
        private set

    fun add(packed: Long) {
        if (size == values.size) values = values.copyOf(values.size * 2)
        values[size++] = packed
    }

    private companion object {
        const val INITIAL = 4096
    }
}

package net.integr.osmium.build

import net.integr.osmium.schematic.SplitMode
import net.integr.osmium.schematic.Vec3i
import net.integr.osmium.schematic.dto.SegmentResponse
import net.integr.osmium.schematic.dto.SplitResponse

/**
 * Divides a box of world between agents, for the jobs that have no file behind them.
 *
 * **The same act as splitting a schematic, with the one thing that makes that hard removed.** A
 * schematic is mostly air unevenly distributed, so its cuts have to be placed where the *blocks*
 * balance rather than where the box does - see `splitSchematic`. A region has no such problem: an
 * operator's two corners describe solid work all the way through, every block weighs the same, and
 * an even cut is a fair one. So this is the same recursive halving with the occupancy index taken
 * out and the arithmetic done on extents.
 *
 * What is kept is the shape of the answer, [SplitResponse], because a job is dispatched, drawn and
 * reported on identically however its pieces were arrived at.
 */
object RegionSplit {
    /**
     * Cuts `[min, max)` into at most [parts] boxes.
     *
     * May return fewer, for the same reason the schematic split may: a strip three blocks wide does
     * not divide between eight agents, and inventing empty pieces to make the number would send
     * five of them to stand in a box with nothing in it.
     *
     * @param topDown numbers the pieces from the highest down, for a job that is dug rather than
     *   built. Ordinal is the order the work happens in, and the scheduler reads it.
     */
    fun of(min: Vec3i, max: Vec3i, mode: SplitMode, parts: Int, topDown: Boolean = false): SplitResponse {
        require(parts >= 1) { "A region cannot be divided between $parts agents" }
        require(max.x > min.x && max.y > min.y && max.z > min.z) {
            "That region has no blocks in it"
        }

        val axes = mode.regionAxes()
        val boxes = divide(Box(min, max), axes, parts)

        val ordered = boxes.sortedWith(
            if (topDown) {
                compareByDescending<Box> { it.min.y }.thenBy { it.min.z }.thenBy { it.min.x }
            } else {
                compareBy<Box>({ it.min.y }, { it.min.z }, { it.min.x })
            },
        )

        val total = ordered.sumOf { it.blocks }

        return SplitResponse(
            mode = mode.name,
            requested = parts,
            parts = ordered.size,
            blocks = total,
            segments = ordered.mapIndexed { index, box ->
                SegmentResponse(
                    ordinal = index + 1,
                    minX = box.min.x,
                    minY = box.min.y,
                    minZ = box.min.z,
                    maxX = box.max.x,
                    maxY = box.max.y,
                    maxZ = box.max.z,
                    blocks = box.blocks,
                    sharePercent = if (total == 0L) 0 else ((box.blocks * 100) / total).toInt(),
                )
            },
        )
    }

    /** Half-open, like everything else that describes a piece of work. */
    private data class Box(val min: Vec3i, val max: Vec3i) {
        fun span(axis: Axis): Int = when (axis) {
            Axis.X -> max.x - min.x
            Axis.Y -> max.y - min.y
            Axis.Z -> max.z - min.z
        }

        /** Every block in the box counts, which is the whole difference from a schematic. */
        val blocks: Long
            get() = span(Axis.X).toLong() * span(Axis.Y) * span(Axis.Z)

        fun cut(axis: Axis, at: Int): Pair<Box, Box> = when (axis) {
            Axis.X -> Box(min, Vec3i(at, max.y, max.z)) to Box(Vec3i(at, min.y, min.z), max)
            Axis.Y -> Box(min, Vec3i(max.x, at, max.z)) to Box(Vec3i(min.x, at, min.z), max)
            Axis.Z -> Box(min, Vec3i(max.x, max.y, at)) to Box(Vec3i(min.x, min.y, at), max)
        }
    }

    private enum class Axis { X, Y, Z }

    /**
     * Halving rather than [parts] cuts along one axis, for the reason the schematic split halves:
     * repeated cuts on a single axis give long thin slices whatever the shape, while halving lets
     * each cut take the axis that is currently longest and produces pieces closer to compact.
     */
    private fun divide(box: Box, axes: Set<Axis>, parts: Int): List<Box> {
        if (parts <= 1) return listOf(box)

        // The longest axis that has room for two pieces. Nothing left to cut means this box is the
        // answer, however many agents were asked for.
        val axis = axes.filter { box.span(it) >= 2 }.maxByOrNull { box.span(it) } ?: return listOf(box)

        val left = parts / 2
        val span = box.span(axis)
        // Proportional rather than half, so an odd division puts the extra work on the side that
        // has more pieces to do it. Clamped so neither side comes out empty.
        val offset = ((span.toLong() * left) / parts).toInt().coerceIn(1, span - 1)

        val (low, high) = box.cut(axis, base(box, axis) + offset)
        return divide(low, axes, left) + divide(high, axes, parts - left)
    }

    private fun base(box: Box, axis: Axis): Int = when (axis) {
        Axis.X -> box.min.x
        Axis.Y -> box.min.y
        Axis.Z -> box.min.z
    }

    /**
     * The axes a mode may cut, spelled here rather than read off [SplitMode].
     *
     * The enum's own axes are `internal` to the schematic package and mean the same thing, but a
     * region has no occupancy index and no cells, so borrowing them would tie this to a definition
     * that exists for a different reason.
     */
    private fun SplitMode.regionAxes(): Set<Axis> = when (this) {
        SplitMode.COLUMNS -> setOf(Axis.X, Axis.Z)
        SplitMode.GRID -> setOf(Axis.X, Axis.Y, Axis.Z)
    }
}

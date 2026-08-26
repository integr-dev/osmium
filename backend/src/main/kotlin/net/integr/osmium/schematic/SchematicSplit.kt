package net.integr.osmium.schematic

/**
 * How a build is divided between agents.
 *
 * The two modes are one algorithm with different axes allowed, not two algorithms. What changes
 * between them is the shape of the pieces - and, because of the shape, how much of the build can be
 * worked at once.
 *
 * **Cutting on Y is an order, not a division.** A bot is two blocks tall and builds from the floor
 * up, standing on the layer below to place the one it is on, so two agents split by height over the
 * same ground are not slow - they are impossible, each needing to stand exactly where the other
 * still has blocks to place. A piece with unfinished work beneath it is therefore not handed out
 * until that work is done; see `BuildJob.blockers`. Vertical modes are safe because of that rule
 * and would be broken without it, and horizontal ones never touch it, having nothing beneath
 * anything.
 */
enum class SplitMode(internal val axes: Set<Axis>) {
    /**
     * Full-height prisms over the footprint. The safe default, and the only mode with no ordering in
     * it at all: every piece is ready from the start, each agent has its own ground, and nothing any
     * of them places waits on a block somebody else has not laid.
     */
    COLUMNS(setOf(Axis.X, Axis.Z)),

    /**
     * Every axis allowed, height included. Balances best, because [bestCut] can put each cut
     * wherever the blocks actually divide rather than being held to the two horizontal ones.
     *
     * The only mode that uses the ordering: pieces at one level go out together while the ones
     * above them wait, so a tall build fills in as a wavefront. Which also bounds it - **how much
     * runs at once is how many pieces sit at the same level**, not how many were asked for. Sixteen
     * pieces four wide and four high keep four agents busy and leave a fifth waiting. And a
     * genuinely tall thin build divides on height alone and comes out serial, because that shape
     * really can only be built by one bot from the floor up.
     *
     * So this is the mode for balance, and [COLUMNS] is the mode for parallelism.
     */
    GRID(setOf(Axis.X, Axis.Y, Axis.Z)),
}

// There was a LAYERS here, cutting on Y alone, and it was **dominated by GRID in every case**. A
// layer is one piece covering the whole footprint, so the ordering rule serialises it to one agent
// at a time: point eight at it and seven watch, for the same throughput as handing one agent the
// whole build. Its one remaining virtue was building bottom-up, and GRID has that from the same
// rule while also cutting horizontally - which makes LAYERS exactly GRID with the useful cuts
// removed. It was written when a vertical cut was thought to be a balance trade rather than a
// physical impossibility, and it did not survive learning which.

internal enum class Axis { X, Y, Z }

/** One agent's share of a build. */
data class Segment(
    val min: Vec3i,
    val max: Vec3i,
    val blocks: Long,
)

data class Split(
    val mode: SplitMode,
    /** How many pieces were asked for. */
    val requested: Int,
    val segments: List<Segment>,
) {
    val blocks: Long get() = segments.sumOf(Segment::blocks)
}

/**
 * Divides a schematic between `parts` agents, working from the occupancy index rather than the
 * file.
 *
 * **Blocks are what is divided, not the box.** Four equal boxes over a cathedral hand one agent the
 * spire and most of the work — the building is mostly air, and the air is not evenly distributed.
 * So each cut is placed where it balances the *counts* either side, which the index makes a matter
 * of summing a few hundred thousand numbers.
 *
 * Cuts land on cell boundaries, never inside a cell. A cell is the finest thing the index can
 * count, so a cut through one would produce two segments whose sizes are unknown — and the whole
 * point of the segments is that their sizes are known.
 *
 * Recursive halving rather than `parts` cuts along one axis: cutting one axis repeatedly gives long
 * thin slices whatever the shape of the build, while halving lets each cut pick the axis that is
 * currently longest and produces pieces closer to compact.
 */
fun splitSchematic(
    cells: List<Cell>,
    cellSize: Int,
    origin: Vec3i,
    bounds: Pair<Vec3i, Vec3i>,
    mode: SplitMode,
    parts: Int,
): Split {
    require(parts >= 1) { "A build cannot be divided between $parts agents" }

    val occupied = cells.filter { it.blocks > 0 }
    if (occupied.isEmpty()) return Split(mode, parts, emptyList())

    val pieces = divide(occupied, mode, parts)

    val segments = pieces
        .map { piece -> segmentOf(piece, cellSize, origin, bounds) }
        // A stable order, so the same schematic split the same way numbers its segments the same
        // way twice. Bottom first, then by depth, then across — the order the build happens in.
        .sortedWith(compareBy({ it.min.y }, { it.min.z }, { it.min.x }))

    return Split(mode, parts, segments)
}

/**
 * Splits into `parts` groups of cells.
 *
 * May return fewer. A schematic three cells wide cannot be divided between eight agents however the
 * cuts are placed, and inventing empty segments to make the count would send five agents to stand
 * in the air. The caller is told what it actually got.
 */
private fun divide(cells: List<Cell>, mode: SplitMode, parts: Int): List<List<Cell>> {
    if (parts <= 1 || cells.size <= 1) return listOf(cells)

    val left = parts / 2
    val total = cells.sumOf { it.blocks.toLong() }
    val cut = bestCut(cells, mode, target = total * left / parts) ?: return listOf(cells)

    return divide(cut.first, mode, left) + divide(cut.second, mode, parts - left)
}

/**
 * The best cut available on any axis this mode may use.
 *
 * Every axis is tried and the one that actually balances wins. Choosing the axis first — by extent,
 * or by how many distinct coordinates it has — and then cutting along it looks reasonable and is
 * how this was written to begin with: it produced splits like 43% / 54% / 1%, because the axis with
 * the most places to cut is not the axis with a good place to cut. A tall thin build offers plenty
 * of boundaries up its height and all of them are useless if the mass is at the bottom.
 */
private fun bestCut(
    cells: List<Cell>,
    mode: SplitMode,
    target: Long,
): Pair<List<Cell>, List<Cell>>? = mode.axes
    .mapNotNull { axis -> cutFor(cells, axis, target) }
    .minByOrNull { (left, _) -> Math.abs(left.sumOf { it.blocks.toLong() } - target) }

/**
 * Where to cut so that the blocks either side come closest to `target` on the left.
 *
 * Whole coordinates only — every cell sharing a coordinate on the cut axis stays together, because
 * a cut inside a cell would split a count the index cannot split.
 */
private fun cutFor(cells: List<Cell>, axis: Axis, target: Long): Pair<List<Cell>, List<Cell>>? {
    val byCoordinate = cells.groupBy { coordinate(it, axis) }.toSortedMap()
    if (byCoordinate.size < 2) return null

    var running = 0L
    var bestCoordinate: Int? = null
    var bestDistance = Long.MAX_VALUE

    // The last coordinate is never a cut: everything on the left leaves the right side empty.
    byCoordinate.entries.toList().dropLast(1).forEach { (coordinate, group) ->
        running += group.sumOf { it.blocks.toLong() }
        val distance = Math.abs(running - target)
        if (distance < bestDistance) {
            bestDistance = distance
            bestCoordinate = coordinate
        }
    }

    val boundary = bestCoordinate ?: return null
    return cells.partition { coordinate(it, axis) <= boundary }
}

/**
 * The box a group of cells occupies, in block coordinates.
 *
 * Clamped to the schematic's own bounds: a cell is a cube of a fixed size and the schematic almost
 * never ends on one, so the outermost cells would otherwise describe segments extending past the
 * build into air nobody is going to place.
 */
private fun segmentOf(
    cells: List<Cell>,
    cellSize: Int,
    origin: Vec3i,
    bounds: Pair<Vec3i, Vec3i>,
): Segment {
    val (low, high) = bounds

    return Segment(
        min = Vec3i(
            Math.max(low.x, origin.x + cells.minOf { it.x } * cellSize),
            Math.max(low.y, origin.y + cells.minOf { it.y } * cellSize),
            Math.max(low.z, origin.z + cells.minOf { it.z } * cellSize),
        ),
        max = Vec3i(
            Math.min(high.x, origin.x + (cells.maxOf { it.x } + 1) * cellSize),
            Math.min(high.y, origin.y + (cells.maxOf { it.y } + 1) * cellSize),
            Math.min(high.z, origin.z + (cells.maxOf { it.z } + 1) * cellSize),
        ),
        blocks = cells.sumOf { it.blocks.toLong() },
    )
}

private fun coordinate(cell: Cell, axis: Axis): Int = when (axis) {
    Axis.X -> cell.x
    Axis.Y -> cell.y
    Axis.Z -> cell.z
}

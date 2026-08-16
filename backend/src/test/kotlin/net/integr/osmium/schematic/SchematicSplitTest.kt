package net.integr.osmium.schematic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Dividing a build between agents.
 *
 * Every way this can be wrong produces a picture that looks like a split. Segments that add up to
 * the wrong total, segments that overlap, one agent handed most of the work — all of them render as
 * a tidy set of boxes, and the first anyone hears of it is a build where nineteen agents finish in
 * an hour and one takes a day.
 */
class SchematicSplitTest {

    private val cellSize = 16
    private val origin = Vec3i(0, 0, 0)

    /** A flat 8x1x8 field of cells, every cell holding the same amount. */
    private fun even(blocks: Int = 100) = buildList {
        for (x in 0 until 8) for (z in 0 until 8) add(Cell(x, 0, z, blocks))
    }

    private fun bounds(cells: List<Cell>) = Vec3i(0, 0, 0) to Vec3i(
        (cells.maxOf { it.x } + 1) * cellSize,
        (cells.maxOf { it.y } + 1) * cellSize,
        (cells.maxOf { it.z } + 1) * cellSize,
    )

    private fun split(cells: List<Cell>, mode: SplitMode, parts: Int) =
        splitSchematic(cells, cellSize, origin, bounds(cells), mode, parts)

    @Test
    fun `divides the blocks, not the box`() {
        // The reason any of this exists. A build with all its mass in one corner divided by volume
        // hands one agent everything; divided by blocks, the segments are even and their *boxes*
        // are wildly different sizes — which is the correct answer looking like the wrong one.
        val lopsided = buildList {
            for (x in 0 until 8) add(Cell(x, 0, 0, if (x == 0) 1_000 else 10))
        }

        val segments = split(lopsided, SplitMode.COLUMNS, 2).segments

        val shares = segments.map { it.blocks }
        assertEquals(2, segments.size)
        // Not perfectly even — one cell holds a thousand and cannot be cut — but the cut is placed
        // to get as close as the cells allow, rather than at the middle of the box.
        assertEquals(1_070L, shares.sum())
        assertTrue(shares.min() >= 70, "the smaller share was ${shares.min()}")
    }

    @Test
    fun `accounts for every block exactly once`() {
        // Segments that overlap or leave a gap both render as a plausible split. This is the only
        // thing that notices.
        val cells = even()
        val total = cells.sumOf { it.blocks.toLong() }

        listOf(SplitMode.COLUMNS, SplitMode.GRID, SplitMode.LAYERS).forEach { mode ->
            (1..8).forEach { parts ->
                assertEquals(total, split(cells, mode, parts).blocks, "$mode into $parts")
            }
        }
    }

    @Test
    fun `balances evenly when the build allows it`() {
        val segments = split(even(), SplitMode.COLUMNS, 4).segments

        assertEquals(4, segments.size)
        // 64 identical cells into four is exactly even, and anything else means the cut is not
        // being placed by count at all.
        segments.forEach { assertEquals(1_600L, it.blocks) }
    }

    @Test
    fun `does not strand an agent with a scrap of the work`() {
        // The failure this replaced: 43% / 54% / 1%. The old code chose the cut axis first, by how
        // many distinct coordinates it had, and only then looked for a cut along it — so it would
        // pick an axis with plenty of boundaries and no good one, rather than the axis with a
        // single boundary in exactly the right place.
        val cells = buildList {
            // Mass along X, and an axis on Z with many boundaries but almost nothing on it.
            for (x in 0 until 12) add(Cell(x, 0, 0, 100))
            for (z in 1 until 20) add(Cell(0, 0, z, 1))
        }

        val segments = split(cells, SplitMode.COLUMNS, 3).segments
        val total = cells.sumOf { it.blocks.toLong() }

        assertEquals(3, segments.size)
        // A third each would be 406. Nothing should be anywhere near a rounding error of the work.
        segments.forEach { segment ->
            assertTrue(
                segment.blocks > total / 6,
                "a segment got ${segment.blocks} of $total, which is not a share of anything",
            )
        }
    }

    @Test
    fun `divides close to evenly for any number of agents`() {
        // 64 identical cells, so every count from 2 to 8 has a fair answer available. What is being
        // checked is that halving actually finds it rather than settling for the first cut it tried.
        val cells = even()
        val total = cells.sumOf { it.blocks.toLong() }

        (2..8).forEach { parts ->
            val segments = split(cells, SplitMode.GRID, parts).segments
            val ideal = total.toDouble() / parts

            segments.forEach { segment ->
                val drift = Math.abs(segment.blocks - ideal) / ideal
                assertTrue(drift < 0.35, "into $parts, a segment was ${segment.blocks} not ~$ideal")
            }
        }
    }

    @Test
    fun `keeps columns full height`() {
        // The safe mode: every agent gets its own ground and builds bottom-up without waiting.
        // A cut on Y here would mean the agent above has nothing to stand on.
        val tall = buildList {
            for (x in 0 until 4) for (y in 0 until 4) add(Cell(x, y, 0, 10))
        }

        val segments = split(tall, SplitMode.COLUMNS, 2).segments

        segments.forEach {
            assertEquals(0, it.min.y)
            assertEquals(4 * cellSize, it.max.y)
        }
    }

    @Test
    fun `cuts layers only horizontally`() {
        val tall = buildList {
            for (x in 0 until 4) for (y in 0 until 4) add(Cell(x, y, 0, 10))
        }

        val segments = split(tall, SplitMode.LAYERS, 2).segments

        assertEquals(2, segments.size)
        // Each slab spans the whole footprint and part of the height — the opposite of columns,
        // and the reason this mode serialises.
        segments.forEach { assertEquals(0, it.min.x) }
        assertTrue(segments.map { it.min.y }.distinct().size == 2)
    }

    @Test
    fun `never cuts through a cell`() {
        // A cell is the finest thing the index counts. A cut inside one produces two segments whose
        // sizes are unknown, and known sizes are the entire point of the segments.
        val cells = even()

        split(cells, SplitMode.GRID, 5).segments.forEach { segment ->
            listOf(segment.min.x, segment.min.y, segment.min.z).forEach {
                assertEquals(0, it % cellSize, "segment edge $it is inside a cell")
            }
        }
    }

    @Test
    fun `returns fewer segments than asked rather than empty ones`() {
        // Three cells cannot be divided between eight agents. Padding the count with empty segments
        // would send five agents to stand in the air waiting for work that does not exist.
        val narrow = listOf(Cell(0, 0, 0, 10), Cell(1, 0, 0, 10), Cell(2, 0, 0, 10))

        val split = split(narrow, SplitMode.COLUMNS, 8)

        assertEquals(8, split.requested)
        assertEquals(3, split.segments.size)
        split.segments.forEach { assertTrue(it.blocks > 0) }
    }

    @Test
    fun `gives the whole build to one agent`() {
        val split = split(even(), SplitMode.GRID, 1)

        assertEquals(1, split.segments.size)
        assertEquals(6_400L, split.segments[0].blocks)
    }

    @Test
    fun `stops at the schematic's edge rather than at the cell's`() {
        // Cells are a fixed size and a schematic almost never ends on one. Unclamped, the outermost
        // segment describes a box extending past the build into air nobody will place.
        val cells = listOf(Cell(0, 0, 0, 10))
        val ragged = Vec3i(0, 0, 0) to Vec3i(20, 5, 20)

        val segment = splitSchematic(cells, cellSize, origin, ragged, SplitMode.GRID, 1).segments[0]

        assertEquals(Vec3i(16, 5, 16), segment.max)
    }

    @Test
    fun `measures segments in the schematic's own coordinates`() {
        // A build saved at y = 60 is built at y = 60. Segments in cell coordinates, or relative to
        // the corner, would send every agent to the wrong place by the same amount.
        val cells = listOf(Cell(0, 0, 0, 10), Cell(1, 0, 0, 10))
        val far = Vec3i(-500, 60, 200)

        val split = splitSchematic(
            cells,
            cellSize,
            far,
            far to Vec3i(-500 + 32, 60 + 16, 200 + 16),
            SplitMode.COLUMNS,
            2,
        )

        assertEquals(Vec3i(-500, 60, 200), split.segments.minByOrNull { it.min.x }!!.min)
    }

    @Test
    fun `numbers the segments the same way twice`() {
        // The preview and whatever is later handed to an agent have to agree about which segment is
        // which, and they are computed separately.
        val first = split(even(), SplitMode.GRID, 6).segments
        val again = split(even(), SplitMode.GRID, 6).segments

        assertEquals(first, again)
    }

    @Test
    fun `handles a schematic with nothing in it`() {
        val split = splitSchematic(emptyList(), cellSize, origin, origin to origin, SplitMode.GRID, 4)

        assertEquals(0, split.segments.size)
        assertEquals(0L, split.blocks)
    }
}

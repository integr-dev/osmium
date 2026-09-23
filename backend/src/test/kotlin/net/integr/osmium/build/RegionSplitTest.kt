package net.integr.osmium.build

import net.integr.osmium.schematic.SplitMode
import net.integr.osmium.schematic.Vec3i
import net.integr.osmium.schematic.dto.SegmentResponse
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Dividing a box of world, where dividing a schematic divides its blocks.
 *
 * The properties worth holding are the ones an operator would notice being broken: every block of
 * the region is in exactly one piece, no piece is empty, and the pieces come out in the order the
 * work happens in. The balance is checked rather than asserted exactly - which cut wins is an
 * implementation detail, and pinning it would make every future change to the halving a failing
 * test about nothing.
 */
class RegionSplitTest {

    private fun blocksIn(segments: List<SegmentResponse>): Long =
        segments.sumOf { it.blocks }

    /** Every block of the region, as a coordinate, so overlaps and gaps are both visible. */
    private fun cover(segments: List<SegmentResponse>): List<Triple<Int, Int, Int>> =
        segments.flatMap { piece ->
            (piece.minX until piece.maxX).flatMap { x ->
                (piece.minY until piece.maxY).flatMap { y ->
                    (piece.minZ until piece.maxZ).map { z -> Triple(x, y, z) }
                }
            }
        }

    @Test
    fun `the pieces tile the region exactly`() {
        val split = RegionSplit.of(Vec3i(0, 0, 0), Vec3i(8, 4, 6), SplitMode.GRID, parts = 5)

        val covered = cover(split.segments)
        assertEquals(8 * 4 * 6, covered.size, "every block is in a piece")
        assertEquals(covered.size, covered.toSet().size, "and in only one")
        assertEquals(blocksIn(split.segments), split.blocks)
    }

    @Test
    fun `columns never cut on height`() {
        val split = RegionSplit.of(Vec3i(0, 60, 0), Vec3i(16, 80, 16), SplitMode.COLUMNS, parts = 4)

        assertEquals(4, split.segments.size)
        assertTrue(
            split.segments.all { it.minY == 60 && it.maxY == 80 },
            "a column is the full height of the region",
        )
    }

    @Test
    fun `a region too small to divide comes back as fewer pieces`() {
        val split = RegionSplit.of(Vec3i(0, 0, 0), Vec3i(2, 1, 1), SplitMode.GRID, parts = 8)

        assertEquals(8, split.requested, "what was asked for is still reported")
        assertEquals(2, split.segments.size, "and there is nothing to make the other six out of")
        assertTrue(split.segments.all { it.blocks > 0 }, "no agent is sent to an empty box")
    }

    @Test
    fun `the division is close to even`() {
        val split = RegionSplit.of(Vec3i(0, 0, 0), Vec3i(32, 8, 32), SplitMode.GRID, parts = 8)

        val even = blocksIn(split.segments) / split.segments.size
        assertTrue(
            split.segments.all { it.blocks in (even / 2)..(even * 2) },
            "no piece is twice or half the fair share: ${split.segments.map { it.blocks }}",
        )
    }

    @Test
    fun `digging is numbered from the top down`() {
        val split = RegionSplit.of(Vec3i(0, 0, 0), Vec3i(4, 8, 4), SplitMode.GRID, parts = 4, topDown = true)

        val heights = split.segments.sortedBy { it.ordinal }.map { it.minY }
        assertEquals(heights.sortedDescending(), heights, "piece 1 is the roof, not the floor")
    }

    @Test
    fun `building is numbered from the bottom up`() {
        val split = RegionSplit.of(Vec3i(0, 0, 0), Vec3i(4, 8, 4), SplitMode.GRID, parts = 4)

        val heights = split.segments.sortedBy { it.ordinal }.map { it.minY }
        assertEquals(heights.sorted(), heights, "piece 1 is the floor")
    }

    @Test
    fun `a flat slab still divides, and stays flat`() {
        val split = RegionSplit.of(Vec3i(-20, 70, -20), Vec3i(20, 71, 20), SplitMode.COLUMNS, parts = 3)

        assertEquals(3, split.segments.size)
        assertTrue(split.segments.all { it.maxY - it.minY == 1 }, "a mapping job is one block thick")
        assertEquals(40L * 40, split.blocks, "and its blocks are its columns")
    }
}

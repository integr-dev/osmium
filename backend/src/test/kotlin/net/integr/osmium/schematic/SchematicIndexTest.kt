package net.integr.osmium.schematic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The summary that stands in for a billion blocks. Everything after this — the split, the material
 * list, the shape on screen — reads this and never the file, so an error here is an error nothing
 * downstream can notice.
 */
class SchematicIndexTest {

    private fun index(edge: Int = 16, origin: Vec3i = Vec3i(0, 0, 0)) = SchematicIndex(edge, origin)

    @Test
    fun `counts blocks into the cell that contains them`() {
        val index = index()
        index.add(0, 0, 0, "minecraft:stone")
        index.add(15, 15, 15, "minecraft:stone")
        index.add(16, 0, 0, "minecraft:stone")

        val cells = index.cells().sortedBy { it.x }

        assertEquals(2, cells.size)
        assertEquals(Cell(0, 0, 0, 2), cells[0])
        assertEquals(Cell(1, 0, 0, 1), cells[1])
        assertEquals(3L, index.blocks)
    }

    @Test
    fun `keeps only the cells that hold something`() {
        val index = index()
        index.add(0, 0, 0, "minecraft:stone")
        index.add(1600, 0, 0, "minecraft:stone")

        // A hundred cells apart on one axis. Storing the empty ones would be storing the bounding
        // box, which for a rail line or a perimeter wall is the whole point of not doing.
        assertEquals(2, index.cells().size)
    }

    @Test
    fun `measures cells from the schematic's own corner, not the world's`() {
        // A build saved at x = -4000 is not a build with negative cells. Relative coordinates are
        // also what lets three of them pack into one long without sign handling.
        val index = index(origin = Vec3i(-4000, -64, -4000))
        index.add(-4000, -64, -4000, "minecraft:stone")
        index.add(-3985, -49, -3985, "minecraft:stone")

        assertEquals(listOf(Cell(0, 0, 0, 2)), index.cells())
    }

    @Test
    fun `totals materials by block, not by block state`() {
        val index = index()
        index.add(0, 0, 0, "minecraft:oak_stairs")
        index.add(1, 0, 0, "minecraft:oak_stairs")
        index.add(2, 0, 0, "minecraft:stone")

        // Stairs facing east and stairs facing west are the same thing to gather. A material list
        // split by state is a list nobody can shop from.
        assertEquals(
            listOf(Material("minecraft:oak_stairs", 2), Material("minecraft:stone", 1)),
            index.materials(),
        )
    }

    @Test
    fun `lists the heaviest material first`() {
        val index = index()
        repeat(3) { index.add(it, 0, 0, "minecraft:dirt") }
        repeat(9) { index.add(it, 1, 0, "minecraft:stone") }
        repeat(9) { index.add(it, 2, 0, "minecraft:glass") }

        // Ties broken by name so the list is stable between runs of the same schematic.
        assertEquals(
            listOf("minecraft:glass", "minecraft:stone", "minecraft:dirt"),
            index.materials().map { it.name },
        )
    }

    @Test
    fun `measures a small build one block at a time`() {
        // A cut can only land on a cell boundary, so cells across an axis are the places a split
        // can go. A house measured in chunk-sized cells has almost nowhere to cut, and its division
        // between agents comes out as lopsided as the grid is coarse.
        assertEquals(1, SchematicIndex.cellEdgeFor(32L * 32 * 32))
    }

    @Test
    fun `coarsens only as far as the count demands`() {
        // 256³ is 16.7 million positions — too many to keep one row each, and an edge of 8 brings
        // it under the target. Not 16: that would throw away half the resolution for nothing.
        val edge = SchematicIndex.cellEdgeFor(256L * 256 * 256)

        assertEquals(8, edge)
        assertTrue((256L * 256 * 256) / (edge.toLong() * edge * edge) <= SchematicIndex.TARGET_CELLS)
    }

    @Test
    fun `coarsens a sparse build rather than storing its bounding box`() {
        // A rail network is a hundred thousand blocks inside a volume in the trillions. At a fixed
        // 16 that is hundreds of millions of rows — a table larger than the schematic it describes.
        val sprawling = 4_000L * 320 * 4_000

        val edge = SchematicIndex.cellEdgeFor(sprawling)

        assertTrue(edge > 16, "an edge of $edge would not have coarsened anything")
        assertTrue(
            sprawling / (edge.toLong() * edge * edge) <= SchematicIndex.TARGET_CELLS,
            "an edge of $edge still leaves more than ${SchematicIndex.TARGET_CELLS} cells",
        )
    }

    @Test
    fun `doubles the edge, so a handful of steps covers any size`() {
        // Each step divides the cell count by eight. Anything smaller would need dozens of steps to
        // reach the sizes this accepts, and anything larger would jump past the useful resolution.
        (0..6).forEach { step ->
            val edge = SchematicIndex.cellEdgeFor(SchematicIndex.TARGET_CELLS * (1L shl (3 * step)) * 16 * 16 * 16)
            assertEquals(16 shl step, edge)
        }
    }

    @Test
    fun `refuses a block outside the grid rather than folding it onto another cell`() {
        val index = index(origin = Vec3i(0, 0, 0))

        // Packing three coordinates into one long has a range, and silently wrapping past it would
        // add a distant block's count to an unrelated cell — a split that then sends an agent
        // somewhere empty.
        val failure = runCatching { index.add(Int.MAX_VALUE, 0, 0, "minecraft:stone") }

        assertTrue(failure.isFailure)
    }
}

package net.integr.osmium.schematic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The preview's two reductions. Both are the difference between a model that can be dragged and one
 * that cannot, and both fail quietly — too much is a browser that stutters, too little is a building
 * with holes in it where solid should be.
 */
class SchematicShapeTest {

    private val origin = Vec3i(0, 0, 0)

    /** A solid block of cells, `edge` on a side. */
    private fun solid(edge: Int) = buildList {
        for (x in 0 until edge) for (y in 0 until edge) for (z in 0 until edge) {
            add(Cell(x, y, z, 1))
        }
    }

    private fun shape(cells: List<Cell>, detail: Int = 64, cellSize: Int = 1) =
        schematicShape(cells, cellSize, origin, detail)

    @Test
    fun `keeps only the shell of something solid`() {
        // The saving that makes this possible at all. A solid's inside grows as the cube of its
        // size and its surface as the square, so at any interesting size almost every voxel is one
        // nobody can see from any angle.
        val result = shape(solid(10))

        // 10³ is 1,000; the shell of a 10-cube is 1000 - 8³ = 488.
        assertEquals(488, result.voxels.size)
        assertEquals(512, result.hidden)
    }

    @Test
    fun `keeps everything of something hollow`() {
        // A wall one cell thick has no interior to drop, so nothing here should vanish. Culling by
        // "has a neighbour" rather than "is enclosed" would eat the middle of every wall.
        val wall = buildList {
            for (x in 0 until 8) for (y in 0 until 8) add(Cell(x, y, 0, 1))
        }

        val result = shape(wall)

        assertEquals(64, result.voxels.size)
        assertEquals(0, result.hidden)
    }

    @Test
    fun `marks exactly the sides with nothing against them`() {
        // Two cells side by side on X. Each hides one face against the other and shows five.
        val pair = listOf(Cell(0, 0, 0, 1), Cell(1, 0, 0, 1))

        val result = shape(pair)
        val left = result.voxels.single { it.x == 0 }
        val right = result.voxels.single { it.x == 1 }

        // Bit order is -X +X -Y +Y -Z +Z, so bit 1 is +X and bit 0 is -X. The left one is hidden on
        // its +X side, the right one on its -X side.
        assertEquals(0b111101, left.faces)
        assertEquals(0b111110, right.faces)
    }

    @Test
    fun `gives a lone cell all six faces`() {
        assertEquals(0b111111, shape(listOf(Cell(4, 4, 4, 1))).voxels.single().faces)
    }

    @Test
    fun `carries a palette rather than a name per voxel`() {
        val mixed = listOf(
            Cell(0, 0, 0, 5, "minecraft:stone"),
            Cell(2, 0, 0, 9, "minecraft:glass"),
            Cell(4, 0, 0, 1, "minecraft:stone"),
        )

        val result = shape(mixed)

        // Index 0 is always the unknown material, present whether or not anything uses it, which
        // saves every reader a branch. Then by how much of the model each covers.
        assertEquals(listOf("", "minecraft:glass", "minecraft:stone"), result.palette)
        assertEquals(
            listOf(2, 1, 2),
            result.voxels.sortedBy { it.x }.map { it.material },
        )
    }

    @Test
    fun `gives a merged voxel the material with the most blocks under it`() {
        // Coarsening puts several cells into one cube, and it takes the colour of the heaviest
        // rather than of whichever sorted last — a glass roof over a stone hall should not turn the
        // hall to glass because the glass cell happened to come later.
        val roofed = listOf(
            Cell(0, 0, 0, 400, "minecraft:stone"),
            Cell(1, 0, 0, 10, "minecraft:glass"),
        )

        val result = shape(roofed, detail = 1)

        assertEquals(1, result.voxels.size)
        assertEquals("minecraft:stone", result.palette[result.voxels.single().material])
    }

    @Test
    fun `leaves a cell with no recorded material on the unknown entry`() {
        // Anything analysed before cells carried a block name. The preview draws it in a default
        // colour rather than inventing one.
        val result = shape(listOf(Cell(0, 0, 0, 4)))

        assertEquals(0, result.voxels.single().material)
        assertEquals("", result.palette[0])
    }

    @Test
    fun `coarsens until the longest axis fits the budget`() {
        // 200 cells across at a budget of 64 needs two halvings: 200 -> 100 -> 50.
        val long = (0 until 200).map { Cell(it, 0, 0, 1) }

        val result = shape(long, detail = 64)

        assertEquals(4, result.voxelSize)
        assertEquals(50, result.size.x)
        assertTrue(result.size.x <= 64)
    }

    @Test
    fun `leaves a small build alone`() {
        // Nothing about a house needs approximating, and coarsening one would throw away the only
        // resolution it had.
        val result = shape(solid(6), detail = 64)

        assertEquals(1, result.voxelSize)
        assertEquals(Vec3i(6, 6, 6), result.size)
    }

    @Test
    fun `merges whole cells, so a block cannot land in two voxels`() {
        // Halving rather than dividing by an arbitrary number: a voxel is exactly the union of the
        // cells under it. Four cells in a row at a budget of 2 become two voxels, not three.
        val row = (0 until 4).map { Cell(it, 0, 0, 1) }

        val result = shape(row, detail = 2)

        assertEquals(2, result.voxelSize)
        assertEquals(2, result.size.x)
        assertEquals(setOf(0, 1), result.voxels.map { it.x }.toSet())
    }

    @Test
    fun `reports where the model belongs in the world`() {
        // The preview is drawn in the schematic's own space, and a corner reported relative to the
        // grid would put the whole building at the origin.
        val cells = listOf(Cell(10, 2, 6, 1))

        val result = schematicShape(cells, cellSize = 4, origin = Vec3i(-500, 64, 200), detail = 64)

        assertEquals(4, result.voxelSize)
        assertEquals(Vec3i(-500 + 40, 64 + 8, 200 + 24), result.origin)
        assertEquals(Vec3i(1, 1, 1), result.size)
    }

    @Test
    fun `bounds what it hands back however large the build`() {
        // The point of the budget. A quarter of a million cells is what the index allows, and every
        // one of them drawn is a preview nobody can turn.
        val sprawling = buildList {
            for (x in 0 until 60) for (y in 0 until 60) for (z in 0 until 60) add(Cell(x, y, z, 1))
        }

        val result = shape(sprawling, detail = 32)

        assertTrue(result.size.x <= 32)
        // 32³ would be 32,768 solid; the shell of a 30-cube is a tenth of that.
        assertTrue(result.voxels.size < 6_000, "handed back ${result.voxels.size} voxels")
    }

    @Test
    fun `handles a schematic with nothing in it`() {
        val result = shape(emptyList())

        assertEquals(0, result.voxels.size)
        assertEquals(Vec3i(0, 0, 0), result.size)
    }
}

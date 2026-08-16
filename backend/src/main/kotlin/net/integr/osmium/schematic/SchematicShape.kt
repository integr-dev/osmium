package net.integr.osmium.schematic

/**
 * One drawable cube of the preview.
 *
 * [faces] is a bitmask of the sides with nothing against them, in the order `-X +X -Y +Y -Z +Z`.
 * A face with a neighbour is inside the solid and can never be seen from anywhere, so it is decided
 * here once rather than by the browser sixty times a second.
 */
data class Voxel(val x: Int, val y: Int, val z: Int, val faces: Int, val material: Int)

data class Shape(
    /** Blocks along one edge of a voxel at this detail. */
    val voxelSize: Int,
    /** Block coordinates of voxel (0, 0, 0). */
    val origin: Vec3i,
    /** Extent in voxels. */
    val size: Vec3i,
    /**
     * The block names the voxels index into, most common first.
     *
     * A palette rather than a name per voxel: a build uses tens of materials and has tens of
     * thousands of voxels, so naming each one would be most of the response. Entry 0 is always the
     * unknown material, which is what a schematic analysed before cells recorded one resolves to.
     */
    val palette: List<String>,
    val voxels: List<Voxel>,
    /** Voxels that were entirely enclosed and therefore dropped. Reported because it is most of them. */
    val hidden: Int,
)

/** Index 0 of every palette: a cell whose material was never recorded. */
const val UNKNOWN_MATERIAL = ""

/**
 * The schematic as something that can be drawn: a coarse voxel model of where the blocks are.
 *
 * Built from the occupancy index rather than the file, so it costs a query rather than a pass. That
 * also fixes its resolution: the index knows *how many* blocks are in a cell, never where inside it,
 * so above a certain size this is a massing model and not a picture. A hollow wall and a solid one
 * look alike once a cell is wider than the wall.
 *
 * Two reductions, and both are needed. A quarter of a million cubes is more than a browser will
 * draw at a frame rate anybody would drag against.
 *
 * **Coarsening** merges cells until the longest axis fits inside `detail`, which bounds the grid to
 * `detail³` before anything else happens.
 *
 * **Enclosure** then throws away every voxel with all six neighbours present. Those are interior:
 * not hidden from *this* angle, hidden from every angle, so dropping them is exact rather than an
 * approximation. It is also where the real saving is — coarsening turns a building into something
 * closer to solid, and a solid's inside grows as the cube of its size while its surface grows as
 * the square.
 */
fun schematicShape(
    cells: List<Cell>,
    cellSize: Int,
    origin: Vec3i,
    detail: Int,
): Shape {
    require(detail >= 1) { "A shape cannot be $detail voxels across" }

    val occupied = cells.filter { it.blocks > 0 }
    if (occupied.isEmpty()) {
        return Shape(cellSize, origin, Vec3i(0, 0, 0), listOf(UNKNOWN_MATERIAL), emptyList(), 0)
    }

    val shift = shiftFor(occupied, detail)
    val voxelSize = cellSize shl shift

    // Merged first, then measured. Coordinates are made relative to the corner so the browser
    // receives small non-negative numbers and the origin says where they belong.
    //
    // A merged voxel takes the material of whichever cell under it holds the most blocks, rather
    // than of whichever happened to be read last. The two agree for anything uniform and differ
    // exactly where it matters: a glass roof over a stone hall should not come out as glass because
    // the glass cell sorted later.
    val merged = HashMap<Vec3i, Cell>()
    occupied.forEach { cell ->
        val at = Vec3i(cell.x shr shift, cell.y shr shift, cell.z shr shift)
        val standing = merged[at]
        if (standing == null || cell.blocks > standing.blocks) merged[at] = cell
    }

    val low = Vec3i(merged.keys.minOf { it.x }, merged.keys.minOf { it.y }, merged.keys.minOf { it.z })
    val high = Vec3i(merged.keys.maxOf { it.x }, merged.keys.maxOf { it.y }, merged.keys.maxOf { it.z })

    val materials = paletteOf(merged.values)
    val present = merged.keys.mapTo(HashSet()) { Vec3i(it.x - low.x, it.y - low.y, it.z - low.z) }

    val visible = ArrayList<Voxel>(present.size)
    var hidden = 0

    merged.forEach { (at, cell) ->
        val voxel = Vec3i(at.x - low.x, at.y - low.y, at.z - low.z)
        val faces = facesOf(voxel, present)
        if (faces == 0) {
            hidden += 1
            return@forEach
        }
        visible += Voxel(voxel.x, voxel.y, voxel.z, faces, materials.getValue(cell.block))
    }

    return Shape(
        voxelSize = voxelSize,
        palette = materials.entries.sortedBy { it.value }.map { it.key },
        origin = Vec3i(
            origin.x + low.x * voxelSize,
            origin.y + low.y * voxelSize,
            origin.z + low.z * voxelSize,
        ),
        size = Vec3i(
            high.x - low.x + 1,
            high.y - low.y + 1,
            high.z - low.z + 1,
        ),
        voxels = visible.sortedWith(compareBy({ it.y }, { it.z }, { it.x })),
        hidden = hidden,
    )
}

/**
 * The materials in play, as name to index.
 *
 * Ordered by how much of the model each covers, so the entries a client is most likely to need a
 * colour for come first — and so the palette is stable between two calls about the same schematic.
 * The unknown material is always index 0, present whether or not anything uses it, which saves
 * every reader a branch.
 */
private fun paletteOf(cells: Collection<Cell>): Map<String, Int> {
    val weight = HashMap<String, Long>()
    cells.forEach { weight.merge(it.block, it.blocks.toLong(), Long::plus) }

    val ordered = weight.entries
        .filter { it.key != UNKNOWN_MATERIAL }
        .sortedWith(compareByDescending<Map.Entry<String, Long>> { it.value }.thenBy { it.key })
        .map { it.key }

    return (listOf(UNKNOWN_MATERIAL) + ordered).withIndex().associate { it.value to it.index }
}

/**
 * How many times to halve the grid so its longest axis fits in `detail`.
 *
 * Powers of two rather than an arbitrary divisor: a shift merges whole cells without redistributing
 * anything, so a voxel is exactly the union of the cells under it and a block cannot land in two.
 */
private fun shiftFor(cells: List<Cell>, detail: Int): Int {
    val span = maxOf(
        cells.maxOf { it.x } - cells.minOf { it.x },
        cells.maxOf { it.y } - cells.minOf { it.y },
        cells.maxOf { it.z } - cells.minOf { it.z },
    ) + 1

    var shift = 0
    while ((span shr shift) > detail) shift += 1
    return shift
}

/** The six neighbour offsets, in the bit order [Voxel.faces] documents. */
private val NEIGHBOURS = listOf(
    Vec3i(-1, 0, 0),
    Vec3i(1, 0, 0),
    Vec3i(0, -1, 0),
    Vec3i(0, 1, 0),
    Vec3i(0, 0, -1),
    Vec3i(0, 0, 1),
)

private fun facesOf(voxel: Vec3i, present: Set<Vec3i>): Int {
    var faces = 0
    NEIGHBOURS.forEachIndexed { bit, offset ->
        val neighbour = Vec3i(voxel.x + offset.x, voxel.y + offset.y, voxel.z + offset.z)
        if (neighbour !in present) faces = faces or (1 shl bit)
    }
    return faces
}

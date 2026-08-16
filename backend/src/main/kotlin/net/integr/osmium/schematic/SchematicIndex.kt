package net.integr.osmium.schematic

/**
 * How many blocks sit in one cell of the grid, where that cell is, and what it is mostly made of.
 *
 * [block] is one name rather than a breakdown: the preview colours a cell, and a cell wide enough
 * to hold two materials is a cell wider than either is worth distinguishing. Empty for rows written
 * before the column existed, which is the one case a reader has to expect.
 */
data class Cell(val x: Int, val y: Int, val z: Int, val blocks: Int, val block: String = "")

/** How much of one block type the whole schematic needs. */
data class Material(val name: String, val blocks: Long)

/**
 * What a pass over a schematic leaves behind.
 *
 * The blocks themselves are never stored — a billion rows is not a table — so this is the summary
 * everything downstream reads instead: a count per cell of a coarse grid, and a count per block
 * type. Both are produced by the one pass that was happening anyway.
 *
 * The cell grid is the load-bearing part. Splitting a build between agents has to divide the
 * **blocks** evenly, not the bounding box: a cathedral is mostly air and its spire is solid, so
 * four equal boxes can hand one agent most of the work. Counting per cell turns that into
 * arithmetic over a few hundred thousand numbers rather than a second pass over a billion.
 */
class SchematicIndex(val cellEdge: Int, private val origin: Vec3i) {

    private val cells = HashMap<Long, Int>()
    private val materials = HashMap<String, Long>()

    /**
     * What each cell is mostly made of, as a running majority vote.
     *
     * Packed into one long — the leading block's id above, how far ahead it is below — so a cell
     * costs sixteen bytes rather than a map of its own. A tally per cell would be exact and would
     * also be a hash map allocated a quarter of a million times and written to once per block, on
     * the one path that runs a billion times.
     *
     * The vote is Boyer–Moore: it returns the true majority whenever one exists, and something
     * frequent when none does. For choosing a colour that distinction does not arise — a cell
     * evenly split between two materials has no honest single colour anyway.
     */
    private val leading = HashMap<Long, Long>()
    private val names = HashMap<String, Int>()
    private val byId = ArrayList<String>()

    var blocks = 0L
        private set

    fun add(x: Int, y: Int, z: Int, name: String) {
        blocks += 1
        materials.merge(name, 1L, Long::plus)

        val key = key(
            (x - origin.x) / cellEdge,
            (y - origin.y) / cellEdge,
            (z - origin.z) / cellEdge,
        )
        cells.merge(key, 1, Int::plus)
        vote(key, idOf(name))
    }

    private fun idOf(name: String): Int = names.getOrPut(name) {
        byId += name
        byId.size - 1
    }

    private fun vote(key: Long, id: Int) {
        val current = leading[key]
        if (current == null) {
            leading[key] = pack(id, 1)
            return
        }

        val leader = (current ushr 32).toInt()
        val margin = current.toInt()

        leading[key] = when {
            leader == id -> pack(leader, margin + 1)
            // Behind by one more. At zero the next block of any kind takes the lead, which is what
            // makes this a majority vote rather than a first-past-the-post one.
            margin > 1 -> pack(leader, margin - 1)
            else -> pack(id, 1)
        }
    }

    private fun pack(id: Int, margin: Int): Long = (id.toLong() shl 32) or margin.toLong()

    /**
     * Only the cells that hold something.
     *
     * A sparse build — a rail line, a perimeter wall — has a bounding box orders of magnitude
     * larger than the thing inside it, and storing its empty cells would be storing the box.
     */
    fun cells(): List<Cell> = cells.map { (key, blocks) ->
        Cell(
            x = unpack(key, 42),
            y = unpack(key, 21),
            z = unpack(key, 0),
            blocks = blocks,
            block = leading[key]?.let { byId[(it ushr 32).toInt()] } ?: "",
        )
    }

    /** Heaviest first, which is the order a material list is read in. */
    fun materials(): List<Material> = materials
        .map { (name, blocks) -> Material(name, blocks) }
        .sortedWith(compareByDescending(Material::blocks).thenBy(Material::name))

    /**
     * Three cell coordinates in one long, so the accumulator is a primitive-keyed map rather than
     * one allocating an object per block placed. Relative to the schematic's own minimum corner, so
     * they are never negative and the packing needs no sign handling.
     */
    private fun key(x: Int, y: Int, z: Int): Long {
        require(x in 0..MAX_CELL && y in 0..MAX_CELL && z in 0..MAX_CELL) {
            "Cell ($x, $y, $z) is outside the grid, which means the origin is wrong"
        }
        return (x.toLong() shl 42) or (y.toLong() shl 21) or z.toLong()
    }

    private fun unpack(key: Long, shift: Int): Int = ((key ushr shift) and MASK).toInt()

    companion object {
        private const val MASK = (1L shl 21) - 1
        private const val MAX_CELL = ((1 shl 21) - 1)

        /**
         * The most cells worth keeping for one schematic. Chosen to bound the table rather than the
         * resolution: a few hundred thousand rows is nothing to store or to sum over, and splitting
         * cannot use more precision than that anyway.
         */
        const val TARGET_CELLS = 250_000L

        /**
         * A single block.
         *
         * The grid exists to be cut between agents, and a cut can only land on a cell boundary — so
         * the number of cells across an axis is the number of places a split can go. At a fixed
         * chunk-sized 16 a small build has almost nowhere to cut, and the division comes out as
         * lopsided as the cells are coarse. Starting at one block and coarsening only when the
         * count demands it means a small build divides exactly and a large one still fits.
         */
        const val MIN_EDGE = 1

        /**
         * How coarse the grid has to be for this schematic.
         *
         * Derived from the volume rather than fixed, and in both directions. Too coarse and a small
         * build has nowhere to cut, so its split comes out lopsided. Too fine and a sparse one — a
         * rail network a hundred thousand blocks long, inside a bounding volume in the trillions —
         * needs a table larger than the schematic it describes.
         *
         * So it starts at a single block and doubles until the count fits, which divides the cell
         * count by eight each step: a handful of steps covers everything from a hut to the sizes at
         * the top of the supported range.
         */
        fun cellEdgeFor(volume: Long): Int {
            var edge = MIN_EDGE
            while (volume / (edge.toLong() * edge * edge) > TARGET_CELLS) edge *= 2
            return edge
        }
    }
}

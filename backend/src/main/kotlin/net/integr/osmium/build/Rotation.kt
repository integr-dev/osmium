package net.integr.osmium.build

/**
 * A plan turned about the vertical, in quarter turns clockwise seen from above.
 *
 * **The footprint turns, and so does every block in it.** Turning the positions alone gives a
 * building the right shape pointing the wrong way at every step: the stairs still climb north, the
 * torches still hang on walls that are now somewhere else, the logs still lie east to west across
 * a hall that now runs north to south. So a turn is applied twice, once to where each block goes
 * and once to what it is — [state] rewrites the properties that name a direction.
 *
 * **The minimum corner stays on the anchor.** A placement is the coordinate an operator stood on
 * and read off the screen, and turning a plan should not move it: the build turns *within* its own
 * box and the box is anchored where it was. A turned footprint is the same box with its two sides
 * swapped on an odd turn.
 *
 * Clockwise is Minecraft's own: north becomes east, east becomes south. `+x` is east and `+z` is
 * south, so a quarter turn takes a step `(x, z)` to `(-z, x)`.
 */
object Rotation {

    /** The turns a plan may have, in degrees. */
    val QUARTERS: Set<Int> = setOf(0, 90, 180, 270)

    fun valid(degrees: Int): Boolean = degrees in QUARTERS

    /** Degrees as quarter turns, 0 to 3. */
    fun turnsOf(degrees: Int): Int = Math.floorMod(degrees / 90, 4)

    /**
     * Where a column of a footprint `sx` by `sz` lands once turned, as its new `x`.
     *
     * Split from [z] rather than returned as a pair: this runs once per block of a segment, and a
     * segment is millions of them — a pair per block is millions of objects for two integers.
     */
    fun x(x: Int, z: Int, sx: Int, sz: Int, turns: Int): Int = when (turns) {
        1 -> sz - 1 - z
        2 -> sx - 1 - x
        3 -> z
        else -> x
    }

    /** Where a column lands once turned, as its new `z`. See [x]. */
    fun z(x: Int, z: Int, sx: Int, sz: Int, turns: Int): Int = when (turns) {
        1 -> x
        2 -> sz - 1 - z
        3 -> sx - 1 - x
        else -> z
    }

    /**
     * A box of the footprint, turned: `[minX, maxX, minZ, maxZ]`, each maximum **exclusive**, as the
     * segments that call this hold them.
     *
     * A box turned by a quarter is still a box — the one thing that makes rotating a division cheap
     * rather than a re-division. Half-open bounds turn onto half-open bounds exactly: the far edge of
     * one axis becomes the near edge of the other.
     */
    fun box(minX: Int, maxX: Int, minZ: Int, maxZ: Int, sx: Int, sz: Int, turns: Int): IntArray = when (turns) {
        1 -> intArrayOf(sz - maxZ, sz - minZ, minX, maxX)
        2 -> intArrayOf(sx - maxX, sx - minX, sz - maxZ, sz - minZ)
        3 -> intArrayOf(minZ, maxZ, sx - maxX, sx - minX)
        else -> intArrayOf(minX, maxX, minZ, maxZ)
    }

    /** The footprint once turned: the same two sides, swapped on an odd turn. */
    fun footprint(sx: Int, sz: Int, turns: Int): Pair<Int, Int> =
        if (turns % 2 == 1) sz to sx else sx to sz

    /**
     * A block state as it reads once turned.
     *
     * Only properties that name a direction change, and each kind changes its own way:
     *
     * - `facing` names one, so it turns — and `up` and `down` do not;
     * - `axis` names a line, so `x` and `z` trade on an odd turn;
     * - `rotation` is sixteenths of a turn, so a quarter adds four;
     * - `north`, `east`, `south` and `west` are *which side* something is on — a fence's arms, a
     *   pane's, a wall's, a vine's — so the values move between the keys rather than changing;
     * - `shape` names a rail's ends, and turns token by token;
     * - `orientation` names a crafter's or a jigsaw's two facings, and turns each.
     *
     * Everything else — `half`, `hinge`, a chest's `type` — is about handedness or height, and a turn
     * keeps both. Properties are written back in sorted order, the spelling the palette uses.
     */
    fun state(spec: String, turns: Int): String {
        val quarter = Math.floorMod(turns, 4)
        if (quarter == 0) return spec

        val open = spec.indexOf('[')
        if (open < 0) return spec
        val close = spec.lastIndexOf(']')
        if (close <= open) return spec

        val name = spec.substring(0, open)
        val properties = spec.substring(open + 1, close)
            .split(',')
            .mapNotNull { pair ->
                val equals = pair.indexOf('=')
                if (equals < 0) null else pair.substring(0, equals).trim() to pair.substring(equals + 1).trim()
            }

        val turned = sortedMapOf<String, String>()
        for ((key, value) in properties) {
            when {
                key in SIDES -> turned[turn(key, quarter)] = value
                key == "facing" -> turned[key] = turnWord(value, quarter)
                key == "axis" -> turned[key] = if (quarter % 2 == 1) swapAxis(value) else value
                key == "rotation" -> turned[key] = value.toIntOrNull()
                    ?.let { Math.floorMod(it + 4 * quarter, 16).toString() }
                    ?: value
                key == "shape" -> turned[key] = turnShape(value, quarter)
                key == "orientation" -> turned[key] = value.split('_').joinToString("_") { turnWord(it, quarter) }
                else -> turned[key] = value
            }
        }

        return "$name[${turned.entries.joinToString(",") { "${it.key}=${it.value}" }}]"
    }

    /** The four sides, clockwise from north: a quarter turn is one step along this list. */
    private val SIDES = listOf("north", "east", "south", "west")

    private fun turn(side: String, quarter: Int): String =
        SIDES[Math.floorMod(SIDES.indexOf(side) + quarter, 4)]

    /** A side turned, and anything that is not a side — `up`, `down`, `straight` — left alone. */
    private fun turnWord(word: String, quarter: Int): String =
        if (word in SIDES) turn(word, quarter) else word

    private fun swapAxis(axis: String): String = when (axis) {
        "x" -> "z"
        "z" -> "x"
        else -> axis
    }

    /**
     * A shape, turned.
     *
     * A stair's `inner_left` names no direction and is left alone — the world works a stair's shape
     * out from its neighbours anyway. A rail's names its two ends, and vanilla spells each pair one
     * way only: `north_south` and `east_west` for the straights, north or south first for a curve,
     * `ascending_` and the side it climbs towards for a slope. So the ends are turned and then put
     * back into that spelling, or the result is a state no version of the game has.
     */
    private fun turnShape(shape: String, quarter: Int): String {
        if (shape.startsWith("ascending_")) return "ascending_" + turnWord(shape.removePrefix("ascending_"), quarter)

        val ends = shape.split('_')
        if (ends.size != 2 || ends.any { it !in SIDES }) return shape

        val turned = ends.map { turn(it, quarter) }.toSet()
        return when (turned) {
            setOf("north", "south") -> "north_south"
            setOf("east", "west") -> "east_west"
            else -> {
                val across = turned.first { it == "north" || it == "south" }
                val along = turned.first { it == "east" || it == "west" }
                "${across}_$along"
            }
        }
    }
}

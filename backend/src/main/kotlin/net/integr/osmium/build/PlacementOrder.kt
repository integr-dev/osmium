package net.integr.osmium.build

/**
 * The order an agent places the blocks of one piece in: three nested sweeps and whether the
 * innermost one snakes.
 *
 * **Carried, not interpreted.** Which block comes next is the host's arithmetic — it is the only
 * party that knows what is already standing there — so this backend stores the token, checks it
 * says something, and hands it on. What it must not do is pass on a token the host would have to
 * guess at: a piece is hours of an agent's work, and an order nobody asked for is worse than a
 * refused job.
 *
 * The form is three signed axes, outermost first, with up to two trailing `s`: `y+z+x+` is bottom
 * to top, north to south, west to east; `y+z+x+s` is the same with the innermost sweep running back
 * the way it came; and `y+z+x+ss` snakes the middle sweep as well, so each layer begins where the
 * one below it ended rather than back at the corner it started from. `+y` is up, `+z` is south and
 * `+x` is east, which is Minecraft's own convention and the one every coordinate here is already in.
 */
object PlacementOrder {

    /** What a job built before the order was a choice, and what a piece without one still gets. */
    const val DEFAULT = "y+z+x+"

    private val SHAPE = Regex("^([xyz][+-]){3}s{0,2}$")

    /** Whether this is an order: three axes, each named once, each with a direction. */
    fun valid(value: String): Boolean {
        if (!SHAPE.matches(value)) return false
        val axes = value.filter { it in "xyz" }
        return axes.toSet().size == axes.length
    }

    /**
     * The token to store for what an operator asked for, or null when they asked for something this
     * is not willing to hand a host.
     */
    fun of(value: String?): String? {
        val token = value?.trim()?.lowercase() ?: return DEFAULT
        if (token.isEmpty()) return DEFAULT
        return if (valid(token)) token else null
    }
}

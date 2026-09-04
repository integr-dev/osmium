package net.integr.osmium.map.model

import java.time.Instant

/**
 * Whether a sighting is of one of ours or of somebody else.
 *
 * Not the same distinction as `nearby[].isAgent`, which answers it for one report. This one is
 * about how the row is addressed: an agent is keyed by its Osmium id, because two agents may share
 * a Minecraft name and because what an operator calls it is its label rather than the account it
 * happens to be wearing. Anyone else has only the one name there is for them.
 */
enum class SubjectKind { AGENT, PLAYER }

/**
 * Where somebody was the last time any agent could see them.
 *
 * **One row per person per world, replaced rather than appended to.** This is not a history: a
 * trail of where somebody has been belongs to the screen watching them move, and lives for as long
 * as that screen is open. What is stored is the single fact that outlives the watching - the last
 * thing the fleet knew - which is what a map draws in grey once somebody has gone.
 *
 * Not a JPA entity, for the reason the map's tiles are not: written far more often than read,
 * always whole, and never partially updated.
 */
data class LastSeen(
    val serverAddress: String,
    /** Which world, without its `minecraft:` prefix. Part of the address, not a label on it. */
    val dimension: String,
    val kind: SubjectKind,
    /** The agent's id written out, or the player's name. */
    val subject: String,
    /** What to call them on screen: an agent's Osmium label, or a player's name. */
    val label: String,
    /** What their head is fetched by - an account uuid, or a name. Null when neither was reported. */
    val face: String?,
    val x: Double,
    val y: Double,
    val z: Double,
    val at: Instant,
) {
    /** How this row is addressed, for holding one of each between flushes. */
    val key: String get() = "$serverAddress|$dimension|$kind|$subject"

    companion object {
        /** As long as the columns are. A host that reports something longer is trimmed, not refused. */
        const val TEXT_MAX = 64
    }
}

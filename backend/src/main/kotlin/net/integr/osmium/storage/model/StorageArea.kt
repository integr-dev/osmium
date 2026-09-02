package net.integr.osmium.storage.model

/**
 * What the database is holding, grouped by what it is holding it for.
 *
 * **Areas, not tables.** A table is an implementation detail an operator has no way to reason
 * about: nobody deciding whether to free space knows that a schematic's blocks live in
 * `schematic_cells` and its material tally in `schematic_materials`, and being shown the two
 * separately makes the question harder rather than more precise. The grouping is the vocabulary the
 * rest of the interface already uses.
 *
 * The list is written down rather than discovered. A table nobody named would otherwise appear on
 * this screen the day it is created, unexplained and with no opinion about whether it can be
 * cleared — and the total would silently start meaning something different. What is missing shows
 * up as [OTHER] instead, which says so.
 */
enum class StorageArea(
    /**
     * The tables that make it up.
     *
     * Every table in the database belongs to exactly one area or to none; the ones belonging to
     * none are reported together rather than dropped, so the areas always add up to the database.
     */
    val tables: List<String>,

    /**
     * The table a purge deletes rows from, or null for an area that cannot be purged here.
     *
     * One table, never several. An area whose rows are entangled — a schematic's cells hang off the
     * schematic, a build hangs off both — cannot be truncated from a storage screen without
     * inventing a second, blunter deletion path beside the one that already understands the
     * relationships. Those areas are shown and left to their own screens.
     */
    val purges: String? = null,

    /** The timestamp column a purge measures age against. Present exactly when [purges] is. */
    val dated: String? = null,
) {
    /** Every line an agent has heard or said. The biggest thing here on a busy server. */
    CHAT(tables = listOf("chat_messages"), purges = "chat_messages", dated = "at"),

    /** Kicks, deaths, disconnections: what happened to agents rather than what was said. */
    ACTIVITY(tables = listOf("activity_entries"), purges = "activity_entries", dated = "at"),

    /**
     * The ground the fleet has charted.
     *
     * Purgeable, and the one area where deleting is close to free: a tile is re-drawn the next time
     * any agent walks over that chunk, so what a purge costs is the parts of the map nobody visits
     * any more — which is exactly the part worth reclaiming.
     */
    MAP(tables = listOf("map_tiles"), purges = "map_tiles", dated = "at"),

    /**
     * The operator trail. **Shown, never purged from here.**
     *
     * A screen that can delete the record of its own use is a screen with a hole in it, and the
     * hole is the shape of somebody covering their tracks. It is exportable — see `audit.export` —
     * so a deployment that needs the space has a way to take the trail with it first, and can then
     * decide about it somewhere that is not one button.
     */
    AUDIT(tables = listOf("audit_entries")),

    /** Uploaded designs and everything derived from them, which is usually the largest single area. */
    SCHEMATICS(tables = listOf("schematics", "schematic_cells", "schematic_materials")),

    /** Build plans, the jobs running them and the pieces handed to agents. */
    BUILDS(
        tables = listOf(
            "builds",
            "build_substitutions",
            "build_jobs",
            "build_job_agents",
            "build_job_substitutions",
            "build_segments",
        ),
    ),

    /** The fleet itself: which agents exist and which machines run them. */
    FLEET(tables = listOf("agents", "hosts")),

    /** Accounts, roles and live sessions. */
    ACCOUNTS(
        tables = listOf("users", "roles", "role_nodes", "permission_nodes", "refresh_tokens"),
    ),

    /**
     * Everything in the database that no area above claims.
     *
     * Always reported, even at zero. Its job is to make the sum honest: without it, a table added
     * by a migration and not listed here would quietly leave the total smaller than the database.
     */
    OTHER(tables = emptyList()),
    ;

    /** Whether this area's rows can be deleted from the storage screen. */
    val purgeable: Boolean get() = purges != null

    companion object {
        /** Every table any area claims, for working out what falls to [OTHER]. */
        val CLAIMED: Set<String> = entries.flatMap { it.tables }.toSet()
    }
}

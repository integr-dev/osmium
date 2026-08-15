package net.integr.osmium.schematic.config

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.util.unit.DataSize
import java.nio.file.Path

/**
 * @param minDataVersion the oldest Minecraft a schematic may have been saved from.
 *
 *   Defaults to **1519, Java Edition 1.13** — the flattening, where blocks stopped being numeric
 *   ids and became the names both formats now store. Below it there is nothing to read: a file from
 *   1.12 does not name its blocks at all.
 *
 *   The range exists because most blocks do not change. Stone from 1.16 is stone in 26.2, and
 *   refusing a build for being old would refuse most of the builds anyone has.
 *
 *   **It buys parseability, not compatibility, and the difference is the whole risk.** Some blocks
 *   *were* renamed — `grass` became `short_grass` in 1.20.3, `sign` became `oak_sign` in 1.14 — and
 *   Osmium cannot tell: it stores block names as strings and never resolves them against a
 *   registry, so a name that no longer exists looks exactly like one that does. Widening this does
 *   not remove that failure, it moves it to the host at build time. The material list is where an
 *   operator can see it coming.
 *
 * @param maxDataVersion the newest, which is the version the fleet actually plays on. Defaults to
 *   26.2. The tighter of the two ends in practice: a schematic from a *newer* Minecraft names
 *   blocks that do not exist yet, and no amount of the game being backwards compatible helps.
 *
 * @param directory where the files live. Not the database: one of these can run to gigabytes and a
 *   Postgres value stops at one. In a container this has to be a mounted volume, or every upload is
 *   lost on the next deploy.
 *
 * @param maxSize the largest upload accepted, declared before a byte of it is sent. A cap is not
 *   optional when the store is a disk shared with the database — without one, the way to take the
 *   whole system down is to start an upload and never stop.
 */
@ConfigurationProperties(prefix = "osmium.schematic")
data class SchematicProperties(
    val minDataVersion: Int = MINECRAFT_1_13,
    val maxDataVersion: Int = MINECRAFT_26_2,
    val directory: Path = Path.of("data", "schematics"),
    val maxSize: DataSize = DataSize.ofGigabytes(8),
) {
    init {
        require(maxSize.toBytes() > 0) {
            "osmium.schematic.max-size must be positive; nothing could be uploaded otherwise"
        }
        require(minDataVersion <= maxDataVersion) {
            "osmium.schematic.min-data-version ($minDataVersion) is above max-data-version " +
                "($maxDataVersion), so every schematic would be refused"
        }
    }

    fun accepts(dataVersion: Int): Boolean = dataVersion in minDataVersion..maxDataVersion

    /**
     * True for a file older than the version the fleet plays on. Not a refusal — it is the case
     * this range exists to allow — but the one thing worth saying out loud about a schematic, since
     * a renamed block is invisible until an agent fails to place it.
     */
    fun isOutdated(dataVersion: Int?): Boolean =
        dataVersion != null && dataVersion < maxDataVersion

    companion object {
        /** Java Edition 26.2, released 16 June 2026. */
        const val MINECRAFT_26_2 = 4903

        /** Java Edition 1.13, the flattening: the first version whose files name their blocks. */
        const val MINECRAFT_1_13 = 1519
    }
}

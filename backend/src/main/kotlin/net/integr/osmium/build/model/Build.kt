package net.integr.osmium.build.model

import jakarta.persistence.CascadeType
import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.FetchType
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.OneToMany
import jakarta.persistence.Table
import net.integr.osmium.schematic.model.Schematic
import java.time.Instant

/**
 * One block swapped for another, or for nothing.
 *
 * [to] is nullable and null means **place nothing**. "I do not have forty stacks of diamond" is the
 * ordinary reason to reach for a substitution, and the honest answer to it is a hole rather than a
 * wrong block quietly standing in where somebody will find it a week later.
 *
 * Neither name is checked against a registry. Osmium stores block names as strings and never
 * resolves them — the same property that lets it accept a schematic from an older Minecraft — so a
 * name that does not exist looks exactly like one that does. The material list is the only place an
 * operator can see what is genuinely in the file.
 */
@Entity
@Table(name = "build_substitutions")
class BuildSubstitution(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "build_id", nullable = false)
    var build: Build? = null,

    @Column(name = "from_block", nullable = false, length = 128)
    var from: String = "",

    @Column(name = "to_block", length = 128)
    var to: String? = null,
)

/**
 * A schematic, somewhere in a world, under the substitutions it is built with.
 *
 * **Its own row rather than fields on the schematic**, because the same schematic is legitimately
 * built more than once: the same tower on two servers, or twice on one at different coordinates and
 * with different substitutions. Placement on the schematic would have made the second of those an
 * upload of the same gigabytes again.
 *
 * This is also where a segment will eventually be dispatched from. Nothing does that yet — the
 * pipeline stops at a division, because carrying a segment to a host needs the host side.
 */
@Entity
@Table(name = "builds")
class Build(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "schematic_id", nullable = false)
    var schematic: Schematic = Schematic(),

    @Column(name = "name", nullable = false, unique = true, length = 128)
    var name: String = "",

    /**
     * Where the schematic's **minimum corner** lands in the world.
     *
     * An anchor rather than an offset, because that is the number an operator has: they stand
     * somewhere, read the coordinate, and want the corner there. The offset the maths needs is
     * derived from it and the schematic's own origin.
     *
     * All three or none. Two of three does not describe a position, and defaulting the missing one
     * to zero would put a half-placed build at bedrock without anybody having said so.
     */
    @Column(name = "place_x") var placeX: Int? = null,
    @Column(name = "place_y") var placeY: Int? = null,
    @Column(name = "place_z") var placeZ: Int? = null,

    /**
     * The server this plan is meant for, as agents report theirs.
     *
     * A coordinate is not a place until it says which world it is in. Optional, like the placement:
     * a plan can be written before anybody knows where it is going. Once set, only agents on this
     * server may be given a job of it.
     */
    @Column(name = "server_address", length = 255) var serverAddress: String? = null,

    /** Which world on that server — `overworld`, as agents report it and the map names it. */
    @Column(name = "dimension", length = 128) var dimension: String? = null,

    /**
     * Quarter turns clockwise, seen from above, in degrees.
     *
     * The build turns inside its own box, so [placeX] and the rest still name the minimum corner —
     * of the turned box. See `Rotation`.
     */
    @Column(name = "rotation", nullable = false) var rotation: Int = 0,

    /**
     * Loaded with the build and replaced wholesale when edited.
     *
     * `orphanRemoval` because a rule taken out of the list is not a rule that belongs to somebody
     * else — it is gone, and a substitution row with no build is a rule that silently applies to
     * nothing.
     */
    @OneToMany(
        mappedBy = "build",
        cascade = [CascadeType.ALL],
        orphanRemoval = true,
        fetch = FetchType.EAGER,
    )
    var substitutions: MutableList<BuildSubstitution> = mutableListOf(),

    /** By name rather than by foreign key: the record should outlive the account that made it. */
    @Column(name = "created_by", nullable = false, length = 64)
    var createdBy: String = "",

    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),

    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
) {
    /** A build with nowhere to stand cannot be dispatched, whatever else is settled about it. */
    val placed: Boolean
        get() = placeX != null && placeY != null && placeZ != null
}

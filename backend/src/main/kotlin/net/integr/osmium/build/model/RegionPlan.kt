package net.integr.osmium.build.model

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Table
import java.time.Instant

/**
 * A box of world somebody means to do something to: dig it out, or fly over it and chart it.
 *
 * **The region half of a [Build].** A build plan is a schematic, a placement and the rules it is
 * built under; this is the same idea with the file taken out, because there is no file — two
 * corners an operator read off the world are the whole description of the work.
 *
 * It exists for the reasons a build plan exists, none of which are about schematics: the same
 * quarry is dug twice, the same valley is charted again next month, and a box nobody has started
 * yet is still worth drawing on the map so two people do not plan the same hole. Retyping six
 * coordinates is exactly the kind of thing that is right five times and wrong the sixth.
 *
 * Half-open, like every box in Osmium: [maxX] is the first block that is *not* in the region. What
 * an operator types is two inclusive corners either way round, and the service sorts them - see
 * `RegionService.boxOf`.
 */
@Entity
@Table(name = "region_plans")
class RegionPlan(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    /**
     * What is to be done to it. Never [BuildJobType.BUILD]: a build comes from a file, and a plan
     * for one is a [Build].
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "type", nullable = false, length = 16)
    var type: BuildJobType = BuildJobType.EXCAVATE,

    @Column(name = "name", nullable = false, unique = true, length = 128)
    var name: String = "",

    /**
     * The server and world these coordinates were read in.
     *
     * Optional, as a [Build]'s are, because deciding to dig somewhere comes before knowing exactly
     * where: a plan that refuses to be saved until every field is settled is a plan nobody writes.
     *
     * **What is not optional is starting one.** Six numbers are only a place once they say which
     * world they were read in, so a job of a region with no server is refused - and the server is
     * never *derived* from whoever is sent, which is the rule a build job follows. That would let a
     * box typed against one world's landscape be dug in another by ticking a different agent, with
     * nothing anywhere saying so. See `BuildJobService.startRegion`.
     */
    @Column(name = "server_address", length = 255) var serverAddress: String? = null,

    /** Which world on that server - `overworld`, as agents report it and the map names it. */
    @Column(name = "dimension", length = 128) var dimension: String? = null,

    /**
     * The box, half-open. All six or none: two corners and four blanks describes nothing.
     *
     * Null is a region somebody has named and not yet been out to measure, which is the state a
     * build plan calls unplaced.
     */
    @Column(name = "min_x") var minX: Int? = null,
    @Column(name = "min_y") var minY: Int? = null,
    @Column(name = "min_z") var minZ: Int? = null,
    @Column(name = "max_x") var maxX: Int? = null,
    @Column(name = "max_y") var maxY: Int? = null,
    @Column(name = "max_z") var maxZ: Int? = null,

    /** By name rather than by foreign key: the record should outlive the account that made it. */
    @Column(name = "created_by", nullable = false, length = 64)
    var createdBy: String = "",

    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),

    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
) {
    /** A region with no box cannot be worked, whatever else is settled about it. */
    val placed: Boolean
        get() = minX != null

    /**
     * How much work is in it: blocks for an excavation, columns of ground for a survey.
     *
     * The same number either way, because a survey's box is one block thick - so its volume *is*
     * its area, and nothing has to know which of the two it is looking at.
     */
    val blocks: Long?
        get() {
            val low = minX ?: return null
            return (maxX!! - low).toLong() * (maxY!! - minY!!) * (maxZ!! - minZ!!)
        }

    /** Where the agents fly while charting, which is the only height a flat box has. */
    val height: Int?
        get() = minY
}

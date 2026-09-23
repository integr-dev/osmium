package net.integr.osmium.build.model

import jakarta.persistence.CascadeType
import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.FetchType
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.OneToMany
import jakarta.persistence.OrderBy
import jakarta.persistence.Table
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.build.PlacementOrder
import net.integr.osmium.schematic.model.Schematic
import java.time.Instant

/**
 * What kind of work a job is: what its pieces came from, and what an agent does with one.
 *
 * Everything else about a job is the same for all three - a crew, a division, a scheduler handing
 * pieces out, hosts reporting counts back - which is why this is a column rather than three tables.
 */
enum class BuildJobType {
    /** A plan, frozen: pieces cut out of a schematic's occupied cells, placed block by block. */
    BUILD,

    /**
     * A box of world, emptied. Pieces are cut out of the box itself, there being no file to count.
     *
     * **Its pieces depend upwards, where a build's depend downwards.** A bot builds standing on
     * what it has laid, so a piece waits for the one beneath it; a bot digs from the top down, so a
     * piece waits for the one *above* it - otherwise it hollows out the floor somebody else is
     * standing on. Same rule, read the other way round. See [BuildJob.blockers].
     */
    EXCAVATE,

    /**
     * A footprint, charted. The agents fly it and report the ground they see.
     *
     * A slab one block thick at the height they fly, so its box has the same shape as any other
     * and nothing that draws one needs to know it is flat. Nothing stands on anything, so every
     * piece is ready from the moment the job starts.
     */
    MAP,
}

/** Where a job is in its life. There is no failed state - see [BuildJob]. */
enum class BuildJobState {
    /** Segments are being handed out, built, and reported on. */
    ACTIVE,

    /**
     * Stopped by an operator, and resumable.
     *
     * **Keeps its crew.** A paused job is one somebody intends to come back to, so the agents stay
     * on their segments and are not free to be given other work - which is exactly what "paused"
     * means and what makes resuming it a single act. An operator who wants the agents back releases
     * a segment or deletes the job, and both say so.
     */
    PAUSED,

    /** Every segment finished. Set by the last report, never by an operator. */
    DONE,
}

/** Where one segment is. */
enum class BuildSegmentState {
    /** Nobody has it. The starting state, and the state a released segment returns to. */
    PENDING,

    /** Handed to an agent. Becomes [BUILDING] when the host says it has started. */
    ASSIGNED,

    /** The host is placing blocks and reporting a count. */
    BUILDING,

    /** Finished. */
    DONE,

    /**
     * The host could not build it and said why.
     *
     * Distinct from [PENDING] on purpose: an agent that dropped out did not fail the work, and the
     * segment it was holding goes back to the pool rather than being flagged for somebody to look
     * at. This state means the host tried and could not.
     */
    FAILED,
}

/**
 * One execution of one build, on one server, against a frozen division of it.
 *
 * A [Build] is a *plan* and stays editable while agents are carrying it out. A job is what was
 * actually started, and must not change under them. So the anchor, the substitutions and the
 * schematic are **pinned here** rather than read back through [build], and the segments are rows
 * rather than the recomputed split they came from.
 *
 * The split is still a pure function of the occupancy index - see `splitSchematic`. What is stored
 * is one *result* of it, because progress has to hang off something with an identity and a
 * recomputed segment has none.
 *
 * **There is no failed job.** A job with failed segments is still [BuildJobState.ACTIVE] and needs
 * an operator, because deciding it is over means picking how many failures are too many and there
 * is no honest number. The operator reassigns, pauses, or deletes it.
 */
@Entity
@Table(name = "build_jobs")
class BuildJob(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    /**
     * What kind of work this is. [BUILD][BuildJobType.BUILD] is the only kind with a plan behind
     * it, which is why [build] and [schematic] are nullable and [regionMaxX] is not always null.
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "type", nullable = false, length = 16)
    var type: BuildJobType = BuildJobType.BUILD,

    /**
     * What to call this job, pinned like everything else on it.
     *
     * It used to be read through [build], which a region job has none of - and it was the worse
     * answer for a build too: renaming a plan halfway through renamed the job, the audit lines it
     * had already written, and the activity on every agent working it.
     */
    @Column(name = "name", nullable = false, length = 128)
    var name: String = "",

    /** The plan behind a [BuildJobType.BUILD]. Null for a region job, which has [regionPlan]. */
    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "build_id")
    var build: Build? = null,

    /**
     * The plan behind an excavation or a survey. Null for a build.
     *
     * Exactly one of the two is set - the database says so - because a job is one execution of one
     * plan, and which table that plan lives in is what [type] says.
     */
    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "region_plan_id")
    var regionPlan: RegionPlan? = null,

    /**
     * Pinned rather than reached through [build], so deleting or re-reading a schematic can be
     * refused while this job is live. A frozen split describes cells that stop existing the moment
     * the file behind them is analysed again.
     *
     * Null for a region job, which divides a box rather than a file.
     */
    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "schematic_id")
    var schematic: Schematic? = null,

    /**
     * Pinned, not joined through the agents.
     *
     * One job is one server. Agents get reassigned mid-job and can be pointed somewhere else
     * between one segment and the next, so deriving this on read would let the target move under a
     * build that is half placed.
     */
    @Column(name = "server_address", nullable = false, length = 128)
    var serverAddress: String = "",

    @Enumerated(EnumType.STRING)
    @Column(name = "state", nullable = false, length = 16)
    var state: BuildJobState = BuildJobState.ACTIVE,

    @Column(name = "split_mode", nullable = false, length = 16)
    var splitMode: String = "",

    /** How many pieces were asked for. [segments] may be fewer - see `splitSchematic`. */
    @Column(name = "requested_parts", nullable = false)
    var requestedParts: Int = 0,

    /**
     * The anchor as it stood when the job started. Not null, where the plan's is: a build with
     * nowhere to stand can exist, a job of one cannot.
     */
    @Column(name = "place_x", nullable = false) var placeX: Int = 0,
    @Column(name = "place_y", nullable = false) var placeY: Int = 0,
    @Column(name = "place_z", nullable = false) var placeZ: Int = 0,

    /**
     * The far corner of a region job's box, exclusive. Null for a build, whose box is its
     * schematic's size from the anchor.
     *
     * The near corner is [placeX] and the rest, which already mean "where the minimum corner is"
     * and mean exactly that here. Exclusive to match the segments cut out of it.
     */
    @Column(name = "region_max_x") var regionMaxX: Int? = null,
    @Column(name = "region_max_y") var regionMaxY: Int? = null,
    @Column(name = "region_max_z") var regionMaxZ: Int? = null,

    /** The plan's turn when the job started, pinned for the same reason the anchor is. */
    @Column(name = "rotation", nullable = false) var rotation: Int = 0,

    /** The world the plan named, if it named one. The server is [serverAddress], from the crew. */
    @Column(name = "dimension", length = 128) var dimension: String? = null,

    /**
     * The sum of the segments, written once.
     *
     * Not the schematic's own block count: the split counts occupied cells, and a part that came
     * back empty is not work anybody was given.
     */
    @Column(name = "total_blocks", nullable = false)
    var totalBlocks: Long = 0,

    @Column(name = "created_by", nullable = false, length = 64)
    var createdBy: String = "",

    @Column(name = "started_at", nullable = false)
    var startedAt: Instant = Instant.now(),

    @Column(name = "finished_at")
    var finishedAt: Instant? = null,

    /**
     * Who is working this job, apart from what they are holding.
     *
     * The crew used to be a *consequence* of the division - as many agents as pieces, each
     * holding one for the life of the job - which left an agent between pieces linked to nothing.
     * A job where a piece waits for the piece below it is full of agents in exactly that position,
     * so membership had to become a thing in its own right.
     *
     * Emptied when the job finishes. This is live membership; who built which piece is recorded on
     * the segment and does not need this list to say it.
     */
    @OneToMany(
        mappedBy = "job",
        cascade = [CascadeType.ALL],
        orphanRemoval = true,
        fetch = FetchType.EAGER,
    )
    var pool: MutableList<BuildJobAgent> = mutableListOf(),

    /** A copy of the plan's rules, frozen. See [BuildJobSubstitution]. */
    @OneToMany(
        mappedBy = "job",
        cascade = [CascadeType.ALL],
        orphanRemoval = true,
        fetch = FetchType.EAGER,
    )
    var substitutions: MutableList<BuildJobSubstitution> = mutableListOf(),

    /**
     * Eager, and capped at `SchematicService.MAX_PARTS`. A job is never read without them - the
     * whole point of the row is what its pieces are doing.
     */
    @OneToMany(
        mappedBy = "job",
        cascade = [CascadeType.ALL],
        orphanRemoval = true,
        fetch = FetchType.EAGER,
    )
    @OrderBy("ordinal ASC")
    var segments: MutableList<BuildSegment> = mutableListOf(),
) {
    val blocksPlaced: Long get() = segments.sumOf(BuildSegment::blocksPlaced)

    /**
     * The unfinished pieces [segment] is waiting for. Empty means it can be handed out.
     *
     * **A bot is two blocks tall and builds bottom-up**, standing on the layer below to place the
     * one it is on - so its body fills its own cell at the height it is working and the height above
     * that. Two agents split by Y over the same ground are therefore not merely inefficient: the
     * upper one has to stand exactly where the lower one still has blocks to place, and no amount of
     * separation fixes it, because what the upper one is waiting for *is* the lower one's work.
     *
     * So Y is never a cut between agents working at the same time. It is an order. This is that
     * order, and it is derived from the boxes rather than stored: the split is frozen the moment the
     * job starts, so the answer cannot drift, and a dependency table could.
     *
     * Costs nothing where it is not needed. A full-height split has nothing beneath anything, so
     * every piece is ready from the start and this returns empty for all of them.
     *
     * Which way the dependency points is the job's [type] - see [BuildJobType.EXCAVATE].
     */
    fun blockers(segment: BuildSegment): List<BuildSegment> = segments.filter { other ->
        other.state != BuildSegmentState.DONE &&
            when (type) {
                // Building rises: a piece waits for the ground it will be laid from.
                BuildJobType.BUILD -> other.isUnder(segment)
                // Digging falls: a piece waits for the roof over it to come off, or it would be
                // hollowing out the floor the agent above is standing on.
                BuildJobType.EXCAVATE -> segment.isUnder(other)
                // One layer, so nothing is over or under anything. Said rather than left to the
                // geometry, because a mapping job is flat by construction and not by luck.
                BuildJobType.MAP -> false
            }
    }

    fun ready(segment: BuildSegment): Boolean = blockers(segment).isEmpty()

    /** Whether every piece is finished, which is the only thing that closes a job. */
    val complete: Boolean
        get() = segments.isNotEmpty() && segments.all { it.state == BuildSegmentState.DONE }
}

/**
 * One agent in a job's pool.
 *
 * Membership, not assignment. An agent is on this job because this row exists; whether it is
 * holding a segment right now is [BuildSegment.agent], and the two move independently - which is
 * the whole point. An agent waiting for a floor to be finished under it is on the job and holding
 * nothing, and before this row there was no way to say that.
 */
@Entity
@Table(name = "build_job_agents")
class BuildJobAgent(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "job_id", nullable = false)
    var job: BuildJob? = null,

    /**
     * Cascades on delete rather than nulling, unlike [BuildSegment.agent]: an agent that is gone is
     * not on the job, while a segment it finished is still the record of who built it.
     */
    @ManyToOne(fetch = FetchType.EAGER, optional = false)
    @JoinColumn(name = "agent_id", nullable = false)
    var agent: Agent = Agent(),

    @Column(name = "agent_label", nullable = false, length = 64)
    var agentLabel: String = "",

    @Column(name = "joined_at", nullable = false)
    var joinedAt: Instant = Instant.now(),
)

/**
 * One substitution, as it stood when the job started.
 *
 * A copy of [BuildSubstitution] rather than a reference to it. An operator editing the plan mid-job
 * is editing the *next* job: agents already placing blocks under the old rules must not end up with
 * half a building under one rule set and half under another.
 */
@Entity
@Table(name = "build_job_substitutions")
class BuildJobSubstitution(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "job_id", nullable = false)
    var job: BuildJob? = null,

    @Column(name = "from_block", nullable = false, length = 128)
    var from: String = "",

    @Column(name = "to_block", length = 128)
    var to: String? = null,
)

/**
 * One agent's share of a job, in **world coordinates** with the anchor already applied.
 *
 * World coordinates because the host does no transform: it is told a box and places what the
 * backend serves for it. Half-open, matching the split it came from - [maxX] is the first block
 * that is *not* in the segment.
 */
@Entity
@Table(name = "build_segments")
class BuildSegment(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id", nullable = false)
    var id: Long? = null,

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "job_id", nullable = false)
    var job: BuildJob? = null,

    /**
     * 1-based, in the split's own order: bottom first, then depth, then across - the order the
     * build happens in, and the number the operator reads.
     */
    @Column(name = "ordinal", nullable = false)
    var ordinal: Int = 0,

    @Column(name = "min_x", nullable = false) var minX: Int = 0,
    @Column(name = "min_y", nullable = false) var minY: Int = 0,
    @Column(name = "min_z", nullable = false) var minZ: Int = 0,
    @Column(name = "max_x", nullable = false) var maxX: Int = 0,
    @Column(name = "max_y", nullable = false) var maxY: Int = 0,
    @Column(name = "max_z", nullable = false) var maxZ: Int = 0,

    /** How many blocks are in this box, from the split. Never recomputed. */
    @Column(name = "blocks", nullable = false)
    var blocks: Long = 0,

    /**
     * The order this piece is placed in: three signed axes, outermost first, with an optional
     * trailing `s` for a snaking innermost sweep. See [net.integr.osmium.build.PlacementOrder].
     *
     * Per piece rather than per job, because the pieces are not alike: a floor is swept differently
     * from the wall above it, and an operator who can say only one thing about a build of sixty-four
     * pieces has to say the thing that suits none of them.
     */
    @Column(name = "placement_order", nullable = false, length = 8)
    var placementOrder: String = PlacementOrder.DEFAULT,

    @Enumerated(EnumType.STRING)
    @Column(name = "state", nullable = false, length = 16)
    var state: BuildSegmentState = BuildSegmentState.PENDING,

    /**
     * Nulled rather than blocking the delete, because a segment outlives the agent that built it.
     * An agent that can never be removed because it once placed blocks is a worse outcome than a
     * finished segment with no assignee.
     */
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "agent_id")
    var agent: Agent? = null,

    /** Which is why the name is snapshotted - the same reasoning as `Build.createdBy`. */
    @Column(name = "agent_label", length = 64)
    var agentLabel: String? = null,

    /**
     * Who an operator took this segment away from.
     *
     * **This is what makes releasing mean something.** Freed, a segment goes back to `PENDING` and
     * the scheduler fills the gap - which handed it straight back to the agent it had just been
     * taken from, that agent being the only idle one and this the only free piece. The button
     * redrew the row exactly as it had been.
     *
     * So the scheduler will not pair the two again. Anyone else may have it, and that agent may be
     * given it deliberately by an operator - which is what clears this.
     *
     * Set only by [BuildJobService.release]. An agent that dropped out of the game did not have
     * its work taken away, so a reconnect finds it eligible for exactly what it was holding.
     */
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "released_from_agent_id")
    var releasedFrom: Agent? = null,

    /**
     * How much of this piece is standing: the higher of what was there when the current holder took
     * it and what that holder says it has placed.
     *
     * **A host counts from zero and cannot do otherwise.** It is told to build a box and starts
     * counting when it starts placing; it has no idea whether anybody built part of it first, and
     * nothing it remembers survives a reconnect. So every hand-over and every resume used to drop
     * the segment back to nothing the moment the new holder said "0 placed, building".
     *
     * The reports stay absolute rather than becoming deltas, which is what makes this safe: the
     * same report applied twice leaves the same number, one that never arrives costs nothing once
     * the next one lands, and a host that restarts mid-piece simply reports its own count again.
     * Deltas are none of those things.
     *
     * Never reset by a release: the blocks are still standing in the world.
     */
    @Column(name = "blocks_placed", nullable = false)
    var blocksPlaced: Long = 0,

    /**
     * What was already standing when the current holder was given this piece.
     *
     * Written on every dispatch and added to on every report. It is the difference between "this
     * agent has placed nothing yet" and "this piece is empty", which is the whole of the bug it
     * exists for.
     */
    @Column(name = "blocks_placed_base", nullable = false)
    var blocksPlacedBase: Long = 0,

    @Column(name = "last_report_at")
    var lastReportAt: Instant? = null,

    @Column(name = "failure_reason", length = 256)
    var failureReason: String? = null,

    /**
     * What a host presents to fetch this segment’s blocks over HTTP.
     *
     * A capability for one segment rather than the host’s own token, which is the credential for
     * the whole machine and every agent on it. **Its life is the assignment**: cleared when the
     * segment is released, finished or handed to somebody else, so it dies with the reason it
     * existed instead of outliving it until a timer notices.
     */
    @Column(name = "fetch_ticket", length = 64)
    var fetchTicket: String? = null,
) {
    /** Held by an agent right now, and therefore not free to hand to another one. */
    val live: Boolean
        get() = state == BuildSegmentState.ASSIGNED || state == BuildSegmentState.BUILDING

    /**
     * Whether [other] stands on this piece: entirely above it, over ground this one covers.
     *
     * Boxes are half-open, so `maxY <= other.minY` is "no shared layer" rather than "one below the
     * other", and the two horizontal tests are overlaps rather than containments - a piece resting
     * on the corner of another still needs it finished. Never true of a piece against itself, since
     * a box with no height is refused by the database.
     */
    fun isUnder(other: BuildSegment): Boolean =
        maxY <= other.minY &&
            minX < other.maxX && other.minX < maxX &&
            minZ < other.maxZ && other.minZ < maxZ
}

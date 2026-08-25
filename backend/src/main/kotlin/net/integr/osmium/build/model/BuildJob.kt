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
import net.integr.osmium.schematic.model.Schematic
import java.time.Instant

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

    @ManyToOne(fetch = FetchType.EAGER, optional = false)
    @JoinColumn(name = "build_id", nullable = false)
    var build: Build = Build(),

    /**
     * Pinned rather than reached through [build], so deleting or re-reading a schematic can be
     * refused while this job is live. A frozen split describes cells that stop existing the moment
     * the file behind them is analysed again.
     */
    @ManyToOne(fetch = FetchType.EAGER, optional = false)
    @JoinColumn(name = "schematic_id", nullable = false)
    var schematic: Schematic = Schematic(),

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

    /** Whether every piece is finished, which is the only thing that closes a job. */
    val complete: Boolean
        get() = segments.isNotEmpty() && segments.all { it.state == BuildSegmentState.DONE }
}

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
     * Last reported, never accumulated. A host that restarts mid-segment recounts what it can see,
     * and summing deltas would double it.
     *
     * Deliberately **not** reset when a segment is released: the blocks are still standing in the
     * world, so the count stays the last thing anybody actually observed until the next agent
     * surveys and reports its own.
     */
    @Column(name = "blocks_placed", nullable = false)
    var blocksPlaced: Long = 0,

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
}

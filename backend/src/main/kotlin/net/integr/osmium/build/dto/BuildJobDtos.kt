package net.integr.osmium.build.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotEmpty
import jakarta.validation.constraints.Size
import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildSegment
import net.integr.osmium.schematic.SplitMode
import java.time.Instant

/** The same width as a plan's name, which is what a build job's name is a copy of. */
const val JOB_NAME_MAX_LENGTH = BUILD_NAME_MAX_LENGTH

/**
 * Starts a job.
 *
 * **Agents are a pool, and the pieces are counted separately.** They used to be the same number,
 * because a piece was a share handed to an agent once and held for the life of the job. A piece is
 * a unit of work now: agents take one, finish it and take the next, so there can be more pieces
 * than agents, and dividing a build finer than the crew is what lets a slow agent take fewer.
 *
 * The server is still derived from the agents rather than asked for: one job is one server, and a
 * field for it would be a second place to say something the pool already says.
 */
@Schema(description = "Starts building a plan with a pool of agents. One job, one server.")
data class StartJobRequest(
    @field:Schema(description = "How to divide the build. COLUMNS is the safe default.")
    val mode: SplitMode,

    /** Every agent must be online, on the same server, and not on another job. */
    @field:NotEmpty
    val agentIds: List<Long>,

    /**
     * How many pieces to divide it into. Defaults to the size of the pool, which is what this used
     * to be fixed at. The split may return fewer - a build three cells wide does not divide into
     * eight - and the extra agents simply wait for something to finish.
     */
    @field:Schema(description = "Pieces to divide into. Defaults to the size of the pool.")
    @field:Min(1)
    val parts: Int? = null,

    @field:Schema(
        description = "The order every piece is placed in: three signed axes, outermost first, " +
            "optionally ending in 's' for a snaking innermost sweep, or 'ss' for a snaking middle " +
            "sweep as well. Defaults to bottom to top, north to south, west to east.",
        example = "y+z+x+",
    )
    val order: String? = null,

    @field:Schema(description = "An order for particular pieces, by ordinal, where it differs from the one above.")
    val segmentOrders: Map<Int, String>? = null,
)

/**
 * One corner of a region, as an operator reads it off the world.
 *
 * Inclusive, and in either order: `from` and `to` are two opposite corners rather than a minimum
 * and a maximum. Somebody standing at two ends of a hole has no idea which of the two numbers is
 * the smaller, and making them find out is a form the interface can fill in itself.
 */
@Schema(description = "One corner of a region, inclusive. The two corners may be given either way round.")
data class CornerRequest(val x: Int, val y: Int, val z: Int)

/**
 * Divides a region plan without starting anything.
 *
 * **The same arithmetic the start would do**, which is the whole point: a preview computed a second
 * way is a picture of a division nobody is going to get. A schematic is previewed the same way, by
 * the endpoint that divides it - see `SchematicController.split`.
 *
 * The box, the world and which way the pieces are numbered all come from the plan, so what is left
 * to ask is how it should be cut.
 */
@Schema(description = "Divides a region plan and returns the pieces, without starting a job.")
data class RegionSplitRequest(
    @field:Schema(description = "How to cut it. A mapping job is always COLUMNS, whatever is sent.")
    val mode: SplitMode = SplitMode.COLUMNS,

    @field:Min(1)
    val parts: Int,
)

@Schema(description = "Puts one agent on a job. Which piece it gets is the scheduler's business.")
data class AddJobAgentRequest(val agentId: Long)

@Schema(description = "One agent working a job, whether or not it is holding a piece right now.")
data class JobAgentResponse(
    @field:Schema(description = "Null once the agent has been deleted.")
    val agentId: Long?,
    val agentLabel: String,
    val joinedAt: Instant,
)

@Schema(description = "Hands one segment to one agent.")
data class AssignSegmentRequest(val agentId: Long)

@Schema(description = "One agent's share of a job, in world coordinates. `max` is exclusive.")
data class JobSegmentResponse(
    val id: Long,
    /** Its place in the build order: bottom first, then by depth, then across. */
    val ordinal: Int,
    val minX: Int,
    val minY: Int,
    val minZ: Int,
    val maxX: Int,
    val maxY: Int,
    val maxZ: Int,
    val blocks: Long,
    /** Of the whole job. The number that says whether the division was fair. */
    val sharePercent: Int,

    @field:Schema(description = "PENDING, ASSIGNED, BUILDING, DONE or FAILED.")
    val state: String,

    @field:Schema(description = "The order this piece is placed in, as three signed axes.", example = "y+z+x+")
    val placementOrder: String,

    @field:Schema(description = "Null when nobody holds it, or when the agent has since been removed.")
    val agentId: Long?,

    @field:Schema(description = "Kept after the agent is gone, so the record still says who built it.")
    val agentLabel: String?,

    @field:Schema(description = "Last reported, never accumulated. Survives a release.")
    val blocksPlaced: Long,

    @field:Schema(description = "Null until a host has reported on this segment.")
    val lastReportAt: Instant?,

    @field:Schema(description = "Why the host could not build it. Null unless FAILED.")
    val failureReason: String?,

    /**
     * Ordinals of the unfinished pieces underneath this one. Empty means it can go out now.
     *
     * Said rather than left to be inferred, because "PENDING with nobody on it while three agents
     * stand idle" reads as something stuck. It is not: a bot is two blocks tall and builds from the
     * floor up, so a piece with unbuilt work beneath it has nowhere for anybody to stand.
     */
    @field:Schema(description = "Unfinished pieces beneath this one. Empty means it is ready.")
    val blockedBy: List<Int>,

    /**
     * Who this was taken from, while it is still being kept from them.
     *
     * Said for the same reason as [blockedBy]: a free piece that the idle agent beside it does not
     * pick up looks like a scheduler that has stopped working. It is an operator’s decision, and
     * the interface should be able to name it rather than leave somebody watching a row.
     */
    @field:Schema(description = "Agent this was released from, and will not be given back to.")
    val releasedFrom: String?,
)

@Schema(description = "One block swapped for another, as it stood when the job started.")
data class JobSubstitutionResponse(val from: String, val to: String?)

/**
 * A job: what is being built, where, by whom, and how far along.
 *
 * The placement and the substitutions here are the job's **own frozen copies**, not the plan's
 * current ones. A plan edited mid-job is the next job's plan.
 */
@Schema(description = "One execution of one build, on one server.")
data class BuildJobResponse(
    val id: Long,

    @field:Schema(description = "BUILD, EXCAVATE or MAP. What the pieces are and what is done to them.")
    val type: String,

    @field:Schema(description = "What this job is called, pinned when it started.")
    val name: String,

    @field:Schema(description = "The build plan behind it. Null for a job that works a region.")
    val buildId: Long?,

    @field:Schema(description = "The region plan behind it. Null for a build.")
    val regionId: Long?,

    @field:Schema(description = "Null for a job with no plan behind it.")
    val schematicId: Long?,

    @field:Schema(description = "Null for a job with no plan behind it.")
    val schematicName: String?,

    val serverAddress: String,

    @field:Schema(description = "ACTIVE, DONE or CANCELLED. There is no failed job.")
    val state: String,

    val splitMode: String,

    @field:Schema(description = "How many pieces were asked for. `segments` can be fewer.")
    val requestedParts: Int,

    @field:Schema(description = "The anchor as it stood when the job started.")
    val placement: PlacementRequest,

    @field:Schema(description = "The plan's turn when the job started: quarter turns clockwise, in degrees.")
    val rotation: Int,

    @field:Schema(
        description = "For a survey: whether the crew climbs over what is in the way rather than " +
            "holding the height it was given. False for anything else.",
    )
    val rising: Boolean,

    @field:Schema(description = "The world the plan named, if it named one. Always set for a region job.")
    val dimension: String?,

    @field:Schema(description = "The schematic's box before the turn, for drawing where the job stands.")
    val size: SizeResponse?,

    /**
     * The far corner of a region job's box, exclusive. Null for a build, whose box is [placement]
     * and [size] under [rotation].
     *
     * Two ways of saying where a job stands rather than one, because they are two different facts:
     * a build occupies the footprint of a file that was turned, and a region *is* the box. Deriving
     * either from the other would mean one of them lying about what it is.
     */
    @field:Schema(description = "The far corner of a region job's box, exclusive. Null for a build.")
    val regionMax: PlacementRequest?,

    val totalBlocks: Long,

    @field:Schema(description = "The sum of the segments' last reported counts.")
    val blocksPlaced: Long,

    @field:Schema(description = "Who is working this job. Empty once it is finished.")
    val pool: List<JobAgentResponse>,

    val substitutions: List<JobSubstitutionResponse>,
    val segments: List<JobSegmentResponse>,

    val createdBy: String,
    val startedAt: Instant,

    @field:Schema(description = "Null while the job is active.")
    val finishedAt: Instant?,
)

fun BuildSegment.toResponse(runTotal: Long, blockedBy: List<Int> = emptyList()): JobSegmentResponse = JobSegmentResponse(
    id = checkNotNull(id) { "Segment has not been persisted yet" },
    ordinal = ordinal,
    minX = minX,
    minY = minY,
    minZ = minZ,
    maxX = maxX,
    maxY = maxY,
    maxZ = maxZ,
    blocks = blocks,
    sharePercent = if (runTotal == 0L) 0 else ((blocks * 100) / runTotal).toInt(),
    state = state.name,
    placementOrder = placementOrder,
    agentId = agent?.id,
    agentLabel = agentLabel,
    blocksPlaced = blocksPlaced,
    lastReportAt = lastReportAt,
    failureReason = failureReason,
    blockedBy = blockedBy,
    releasedFrom = releasedFrom?.label,
)

fun BuildJob.toResponse(): BuildJobResponse = BuildJobResponse(
    id = checkNotNull(id) { "Job has not been persisted yet" },
    type = type.name,
    name = name,
    buildId = build?.id,
    regionId = regionPlan?.id,
    schematicId = schematic?.id,
    schematicName = schematic?.name,
    serverAddress = serverAddress,
    state = state.name,
    splitMode = splitMode,
    requestedParts = requestedParts,
    placement = PlacementRequest(placeX, placeY, placeZ),
    rotation = rotation,
    rising = rising,
    dimension = dimension,
    size = schematic?.sizeOrNull(),
    regionMax = regionMaxX?.let { PlacementRequest(it, regionMaxY!!, regionMaxZ!!) },
    totalBlocks = totalBlocks,
    blocksPlaced = blocksPlaced,
    // Sorted so the list read back is the list that will be read back next time; the database has
    // no opinion on the order rows come out in.
    pool = pool
        .sortedBy { it.agentLabel }
        .map { JobAgentResponse(it.agent.id, it.agentLabel, it.joinedAt) },
    substitutions = substitutions
        .sortedBy { it.from }
        .map { JobSubstitutionResponse(it.from, it.to) },
    segments = segments
        .sortedBy { it.ordinal }
        .map { piece -> piece.toResponse(totalBlocks, blockers(piece).map { it.ordinal }.sorted()) },
    createdBy = createdBy,
    startedAt = startedAt,
    finishedAt = finishedAt,
)

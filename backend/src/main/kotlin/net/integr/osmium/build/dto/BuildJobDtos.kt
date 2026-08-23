package net.integr.osmium.build.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.NotEmpty
import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildSegment
import net.integr.osmium.schematic.SplitMode
import java.time.Instant

/**
 * Starts a job.
 *
 * **Agents, not a part count.** The number of pieces a build is divided into *is* the number of
 * agents carrying them, and asking for both is asking for two answers that have to agree. The
 * server is derived from the agents for the same reason: one job is one server, and a field for it
 * would be a second place to say something the agents already say.
 */
@Schema(description = "Starts building a plan with a set of agents. One job, one server.")
data class StartJobRequest(
    @field:Schema(description = "How to divide the build. COLUMNS is the safe default.")
    val mode: SplitMode,

    /**
     * Every agent must be online and on the same server. The split is asked for this many parts and
     * may return fewer, in which case the agents left over are told so rather than assigned a piece
     * of nothing.
     */
    @field:NotEmpty
    val agentIds: List<Long>,
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
    val buildId: Long,
    val buildName: String,
    val schematicId: Long,
    val schematicName: String,
    val serverAddress: String,

    @field:Schema(description = "ACTIVE, DONE or CANCELLED. There is no failed job.")
    val state: String,

    val splitMode: String,

    @field:Schema(description = "How many pieces were asked for. `segments` can be fewer.")
    val requestedParts: Int,

    @field:Schema(description = "The anchor as it stood when the job started.")
    val placement: PlacementRequest,

    val totalBlocks: Long,

    @field:Schema(description = "The sum of the segments' last reported counts.")
    val blocksPlaced: Long,

    val substitutions: List<JobSubstitutionResponse>,
    val segments: List<JobSegmentResponse>,

    val createdBy: String,
    val startedAt: Instant,

    @field:Schema(description = "Null while the job is active.")
    val finishedAt: Instant?,
)

fun BuildSegment.toResponse(runTotal: Long): JobSegmentResponse = JobSegmentResponse(
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
    agentId = agent?.id,
    agentLabel = agentLabel,
    blocksPlaced = blocksPlaced,
    lastReportAt = lastReportAt,
    failureReason = failureReason,
)

fun BuildJob.toResponse(): BuildJobResponse = BuildJobResponse(
    id = checkNotNull(id) { "Job has not been persisted yet" },
    buildId = checkNotNull(build.id) { "Job has no build" },
    buildName = build.name,
    schematicId = checkNotNull(schematic.id) { "Job has no schematic" },
    schematicName = schematic.name,
    serverAddress = serverAddress,
    state = state.name,
    splitMode = splitMode,
    requestedParts = requestedParts,
    placement = PlacementRequest(placeX, placeY, placeZ),
    totalBlocks = totalBlocks,
    blocksPlaced = blocksPlaced,
    // Sorted so the list read back is the list that will be read back next time; the database has
    // no opinion on the order rows come out in.
    substitutions = substitutions
        .sortedBy { it.from }
        .map { JobSubstitutionResponse(it.from, it.to) },
    segments = segments
        .sortedBy { it.ordinal }
        .map { it.toResponse(totalBlocks) },
    createdBy = createdBy,
    startedAt = startedAt,
    finishedAt = finishedAt,
)

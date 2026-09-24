package net.integr.osmium.build.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotEmpty
import jakarta.validation.constraints.Size
import net.integr.osmium.build.model.BuildJobType
import net.integr.osmium.build.model.RegionPlan
import net.integr.osmium.schematic.SplitMode
import java.time.Instant

/**
 * Region plans: a box of world somebody means to dig out or chart.
 *
 * The vocabulary is a plan's, matching `BuildDtos`: a region is *created*, *edited* and *placed*,
 * and a job *of* it is started. What it does not have is a schematic, substitutions or a turn —
 * there is no file to substitute the blocks of or to turn.
 */

/**
 * Creates a region plan.
 *
 * **Everything but the name and the kind can be settled later**, as on a build plan: deciding to
 * dig somewhere comes before knowing exactly where, and a plan that refuses to be saved until
 * every field is filled in is a plan nobody writes. Starting a job of one is where the corners and
 * the server become mandatory.
 */
@Schema(description = "Creates a region plan. The corners and the server can be settled later.")
data class CreateRegionRequest(
    @field:NotBlank
    @field:Size(max = REGION_NAME_MAX_LENGTH)
    val name: String,

    @field:Schema(description = "EXCAVATE or MAP. A build comes from a file and its plan is a build.")
    val type: BuildJobType,

    @field:Valid
    @field:Schema(description = "One corner, inclusive. Both together or neither.")
    val from: CornerRequest? = null,

    @field:Valid val to: CornerRequest? = null,

    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(description = "The server these corners were read on.", example = "play.example.net")
    val serverAddress: String? = null,

    @field:Size(max = DIMENSION_MAX_LENGTH)
    @field:Schema(description = "Which world on it.", example = "overworld")
    val dimension: String? = null,

    @field:Schema(
        description = "For a survey: whether the crew climbs over what is in the way instead of " +
            "holding one height. The height given then reads as the lowest one. Ignored for an " +
            "excavation.",
    )
    val rising: Boolean = false,
)

/**
 * Edits a region plan. Omitted fields are left as they are.
 *
 * The corners come as a pair or not at all: one corner of a new box and one of the old describes
 * somewhere nobody chose. A blank server or world clears it, the way a build plan's does — JSON
 * cannot tell a missing field from a null one, and an empty string is the one value that is never
 * a server anybody meant.
 */
@Schema(description = "Edits a region plan. Omitted fields are left as they are.")
data class UpdateRegionRequest(
    @field:Size(max = REGION_NAME_MAX_LENGTH)
    val name: String? = null,

    @field:Valid val from: CornerRequest? = null,
    @field:Valid val to: CornerRequest? = null,

    @field:Schema(description = "Takes the corners off, for a region somebody wants to measure again.")
    val unplace: Boolean = false,

    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    val serverAddress: String? = null,

    @field:Size(max = DIMENSION_MAX_LENGTH)
    val dimension: String? = null,

    @field:Schema(description = "For a survey: whether the crew climbs over what is in the way.")
    val rising: Boolean? = null,
)

/**
 * Starts a job of a region plan.
 *
 * **No box, no world and no server**, unlike the request this replaced: all four came from the
 * plan the moment there was one to come from, and a second place to say them is a second place for
 * them to be wrong. What is left is what a build job's start carries — a crew, a division and an
 * order.
 */
@Schema(description = "Starts working a region plan with a pool of agents. One job, one server.")
data class StartRegionJobRequest(
    @field:Schema(description = "How to divide the box. A mapping job is always COLUMNS.")
    val mode: SplitMode = SplitMode.COLUMNS,

    /** Every agent must be online, not on another job, and on the plan's own server. */
    @field:NotEmpty
    val agentIds: List<Long>,

    @field:Schema(description = "Pieces to divide into. Defaults to the size of the pool.")
    @field:Min(1)
    val parts: Int? = null,

    @field:Schema(
        description = "The order every piece is worked in: three signed axes, outermost first, " +
            "optionally ending in 's' or 'ss' for snaking sweeps. An excavation defaults to top " +
            "to bottom; a mapping job has one sensible sweep and ignores this.",
        example = "y-z+x+",
    )
    val order: String? = null,

    @field:Schema(description = "An order for particular pieces, by ordinal, where it differs.")
    val segmentOrders: Map<Int, String>? = null,
)

@Schema(description = "A box of world somebody means to dig out or chart.")
data class RegionResponse(
    val id: Long,

    @field:Schema(description = "EXCAVATE or MAP.")
    val type: String,

    val name: String,

    @field:Schema(description = "Null until somebody says which server these corners were read on.")
    val serverAddress: String?,

    @field:Schema(description = "Null until somebody says which world.")
    val dimension: String?,

    @field:Schema(description = "Whether it has a box at all. A region without one cannot be worked.")
    val placed: Boolean,

    @field:Schema(description = "The minimum corner: where the box starts. Null while unplaced.")
    val placement: PlacementRequest?,

    @field:Schema(description = "The far corner, exclusive — the first block outside the box.")
    val regionMax: PlacementRequest?,

    @field:Schema(description = "Its three sides in blocks, which is what an operator reads.")
    val size: SizeResponse?,

    @field:Schema(description = "Blocks for an excavation, columns of ground for a survey.")
    val blocks: Long?,

    @field:Schema(description = "The height the agents fly, for a survey. The box's floor otherwise.")
    val height: Int?,

    @field:Schema(
        description = "For a survey: whether the crew climbs over what is in the way, in which " +
            "case the height is the lowest one rather than the only one.",
    )
    val rising: Boolean,

    val createdBy: String,
    val createdAt: Instant,
    val updatedAt: Instant,
)

/** The same width as a build plan's name, which is the thing beside it in every list. */
const val REGION_NAME_MAX_LENGTH = BUILD_NAME_MAX_LENGTH

fun RegionPlan.toResponse(): RegionResponse = RegionResponse(
    id = checkNotNull(id) { "Region has not been persisted yet" },
    type = type.name,
    name = name,
    serverAddress = serverAddress,
    dimension = dimension,
    placed = placed,
    placement = minX?.let { PlacementRequest(it, minY!!, minZ!!) },
    regionMax = maxX?.let { PlacementRequest(it, maxY!!, maxZ!!) },
    size = minX?.let { SizeResponse(maxX!! - it, maxY!! - minY!!, maxZ!! - minZ!!) },
    blocks = blocks,
    height = height,
    rising = rising,
    createdBy = createdBy,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

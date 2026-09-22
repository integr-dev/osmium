package net.integr.osmium.build.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import net.integr.osmium.build.model.Build
import net.integr.osmium.schematic.model.Schematic
import java.time.Instant

const val BUILD_NAME_MAX_LENGTH = 128
const val BLOCK_NAME_MAX_LENGTH = 128
const val SERVER_ADDRESS_MAX_LENGTH = 255
const val DIMENSION_MAX_LENGTH = 128

/**
 * A box's three sides, in blocks.
 *
 * Carried on a plan and a job so the map and the 3D view can draw where the build stands without
 * a second request per box — the footprint is the placement, this, and the turn.
 */
@Schema(description = "A box's three sides, in blocks.")
data class SizeResponse(val x: Int, val y: Int, val z: Int)

/** The schematic's box, once it has been read. Null before that: nothing is known about it yet. */
fun Schematic.sizeOrNull(): SizeResponse? {
    val x = sizeX ?: return null
    val y = sizeY ?: return null
    val z = sizeZ ?: return null
    return SizeResponse(x, y, z)
}

@Schema(
    description = "One block swapped for another. A null or blank replacement means place nothing " +
        "at all, which is the honest answer to not having the material.",
)
data class SubstitutionRequest(
    @field:NotBlank
    @field:Size(max = BLOCK_NAME_MAX_LENGTH)
    @field:Schema(example = "minecraft:diamond_block")
    val from: String,

    @field:Size(max = BLOCK_NAME_MAX_LENGTH)
    @field:Schema(example = "minecraft:stone", nullable = true)
    val to: String?,
)

data class SubstitutionResponse(val from: String, val to: String?)

/**
 * Where the schematic's minimum corner lands.
 *
 * All three together or none at all: two of three does not describe a position, and letting one
 * default would put a half-placed build somewhere nobody chose.
 */
@Schema(description = "Where the schematic's minimum corner lands in the world.")
data class PlacementRequest(val x: Int, val y: Int, val z: Int)

@Schema(description = "Creates a build. Placement and substitutions can both be settled later.")
data class CreateBuildRequest(
    @field:NotBlank
    @field:Size(max = BUILD_NAME_MAX_LENGTH)
    val name: String,

    val schematicId: Long,

    @field:Valid
    val placement: PlacementRequest? = null,

    @field:Valid
    val substitutions: List<SubstitutionRequest> = emptyList(),

    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(description = "The server this plan is for, as agents report theirs.", example = "play.example.net")
    val serverAddress: String? = null,

    @field:Size(max = DIMENSION_MAX_LENGTH)
    @field:Schema(description = "Which world on that server.", example = "overworld")
    val dimension: String? = null,

    @field:Schema(description = "Quarter turns clockwise seen from above, in degrees: 0, 90, 180 or 270.")
    val rotation: Int = 0,
)

/**
 * Everything about a build that an operator sets. A field left out is left alone; `placement` is
 * the exception, where **explicitly null means unplace it** — see [UpdateBuildRequest.unplace].
 */
@Schema(description = "Edits a build. Omitted fields are left as they are.")
data class UpdateBuildRequest(
    @field:Size(max = BUILD_NAME_MAX_LENGTH)
    val name: String? = null,

    @field:Valid
    val placement: PlacementRequest? = null,

    /**
     * Clears the placement. A separate flag rather than reading a null `placement` as "remove it",
     * because JSON cannot tell an absent field from a null one — and the two mean opposite things
     * here: leave the placement alone, or take it away.
     */
    val unplace: Boolean = false,

    /**
     * Replaces the whole rule set when present. Wholesale rather than per-rule patching: the list
     * is short, it is edited as a list, and a partial update would need an identity for each rule
     * that the operator never sees.
     */
    @field:Valid
    val substitutions: List<SubstitutionRequest>? = null,

    /** The server it is for. Blank takes it off again; absent leaves it as it is. */
    @field:Size(max = SERVER_ADDRESS_MAX_LENGTH)
    @field:Schema(description = "The server it is for. Blank clears it; omitted leaves it alone.")
    val serverAddress: String? = null,

    /** Which world on that server. Blank takes it off again; absent leaves it as it is. */
    @field:Size(max = DIMENSION_MAX_LENGTH)
    @field:Schema(description = "Which world on that server. Blank clears it; omitted leaves it alone.")
    val dimension: String? = null,

    @field:Schema(description = "Quarter turns clockwise seen from above, in degrees: 0, 90, 180 or 270.")
    val rotation: Int? = null,
)

@Schema(description = "A build: a schematic, where it goes, and what it is built out of.")
data class BuildResponse(
    val id: Long,
    val name: String,
    val schematicId: Long,
    val schematicName: String,
    @field:Schema(description = "Null until the build has been placed.")
    val placement: PlacementRequest?,
    val substitutions: List<SubstitutionResponse>,
    @field:Schema(description = "False while it has nowhere to stand, whatever else is settled.")
    val placed: Boolean,
    @field:Schema(description = "The server it is for. Null until somebody says.")
    val serverAddress: String?,
    @field:Schema(description = "Which world on that server. Null until somebody says.")
    val dimension: String?,
    @field:Schema(description = "Quarter turns clockwise seen from above, in degrees.")
    val rotation: Int,
    @field:Schema(description = "The schematic's box, before the turn: what a footprint is drawn from.")
    val size: SizeResponse?,
    val createdBy: String,
    val createdAt: Instant,
    val updatedAt: Instant,
)

fun Build.toResponse(): BuildResponse = BuildResponse(
    id = checkNotNull(id) { "Build has not been persisted yet" },
    name = name,
    schematicId = checkNotNull(schematic.id) { "Build has no schematic" },
    schematicName = schematic.name,
    placement = if (placed) PlacementRequest(placeX!!, placeY!!, placeZ!!) else null,
    // Sorted so the list an operator reads back is the list they will read back next time; the
    // database has no opinion on the order rows come out in.
    substitutions = substitutions
        .sortedBy { it.from }
        .map { SubstitutionResponse(it.from, it.to) },
    placed = placed,
    serverAddress = serverAddress,
    dimension = dimension,
    rotation = rotation,
    size = schematic.sizeOrNull(),
    createdBy = createdBy,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

package net.integr.osmium.schematic.dto

import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import net.integr.osmium.schematic.model.Schematic
import net.integr.osmium.schematic.model.SchematicStatus
import java.time.Instant

/**
 * Starting an upload. The size is declared **before** any bytes are sent, which is what lets an
 * upload too large for this deployment be refused in one small request rather than after an hour
 * of transfer.
 */
data class CreateSchematicRequest(
    @field:NotBlank
    @field:Size(max = 128)
    val name: String,

    @field:NotBlank
    @field:Size(max = 255)
    val filename: String,

    @field:Min(1)
    val sizeBytes: Long,
)

data class RenameSchematicRequest(
    @field:NotBlank
    @field:Size(max = 128)
    val name: String,
)

/** What the file turned out to contain. Null throughout until it has been read. */
data class SchematicContentResponse(
    val format: String?,
    val dataVersion: Int?,
    val volume: Long?,
    val blockCount: Long?,
    val regionCount: Int?,
    /** The minimum corner: where the box sits, and what its corner labels read. */
    val originX: Int?,
    val originY: Int?,
    val originZ: Int?,
    val sizeX: Int?,
    val sizeY: Int?,
    val sizeZ: Int?,
    /** The edge of one index cell, in blocks. Coarsened for a sparse build — see SchematicIndex. */
    val cellSize: Int?,
    /**
     * Saved from a Minecraft older than the one the fleet plays on. Accepted deliberately — most
     * blocks do not change between versions — but worth saying, because the ones that were renamed
     * are invisible here and only fail when an agent tries to place one.
     */
    val outdated: Boolean,
)

/** One block type and how much of it the whole schematic needs. */
data class MaterialResponse(val name: String, val blocks: Long)

data class SchematicResponse(
    val id: Long,
    val name: String,
    val originalFilename: String,
    val sizeBytes: Long,
    /**
     * How much has arrived. The client resumes from here after a failure rather than starting
     * again, so it is on the ordinary read of a schematic and not behind a call of its own.
     */
    val receivedBytes: Long,
    val status: SchematicStatus,
    val progressPercent: Int,
    val contentHash: String?,
    val content: SchematicContentResponse,
    val failure: String?,
    val uploadedBy: String,
    val createdAt: Instant,
    val updatedAt: Instant,
)

/**
 * @param buildsFor the newest Minecraft this fleet builds, so a file older than it can be marked.
 *   Passed in rather than read from config here: a DTO mapper that reaches for a bean is a DTO
 *   mapper that cannot be called from a test without one.
 */
fun Schematic.toResponse(buildsFor: Int? = null) = SchematicResponse(
    id = id ?: 0,
    name = name,
    originalFilename = originalFilename,
    sizeBytes = sizeBytes,
    receivedBytes = receivedBytes,
    status = status,
    progressPercent = progressPercent,
    contentHash = contentHash,
    content = SchematicContentResponse(
        format = format?.name,
        dataVersion = dataVersion,
        volume = volume,
        blockCount = blockCount,
        regionCount = regionCount,
        originX = originX,
        originY = originY,
        originZ = originZ,
        sizeX = sizeX,
        sizeY = sizeY,
        sizeZ = sizeZ,
        cellSize = cellSize,
        outdated = buildsFor != null && dataVersion != null && dataVersion!! < buildsFor,
    ),
    failure = failure,
    uploadedBy = uploadedBy,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

/** One agent's share, as the interface draws it. */
data class SegmentResponse(
    /** Its place in the build order: bottom first, then by depth, then across. */
    val ordinal: Int,
    val minX: Int,
    val minY: Int,
    val minZ: Int,
    val maxX: Int,
    val maxY: Int,
    val maxZ: Int,
    val blocks: Long,
    /** Of the whole build. The number that says whether the division is fair. */
    val sharePercent: Int,
)

data class SplitResponse(
    val mode: String,
    /** How many agents were asked for. */
    val requested: Int,
    /**
     * How many the build actually divides into, which can be fewer. A schematic three cells wide
     * cannot be split between eight agents, and inventing empty segments to make the number would
     * send five of them to stand in the air.
     */
    val parts: Int,
    val blocks: Long,
    val segments: List<SegmentResponse>,
)

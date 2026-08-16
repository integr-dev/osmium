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
    /**
     * Where it sits in the reading queue, 1 meaning next. Null unless it is waiting — a schematic
     * being read, or already read, is not in a line — and null for a moment after the last chunk
     * lands, because the queue is only joined once that transaction commits.
     *
     * Not on the row. It is a fact about the other schematics rather than about this one, and
     * storing it would mean rewriting every waiting row each time one is taken.
     */
    val queuePosition: Int?,
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
 * @param queuePosition where it is waiting, from the analysis queue. Same reasoning — the queue is
 *   in memory and not something a mapper should be reaching into.
 */
fun Schematic.toResponse(buildsFor: Int? = null, queuePosition: Int? = null) = SchematicResponse(
    id = id ?: 0,
    name = name,
    originalFilename = originalFilename,
    sizeBytes = sizeBytes,
    receivedBytes = receivedBytes,
    status = status,
    progressPercent = progressPercent,
    queuePosition = queuePosition,
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

/**
 * The schematic as something drawable: a coarse voxel model of where its blocks are.
 *
 * [voxels] is flat — `x, y, z, faces, material` repeated — rather than a list of objects. At tens of thousands
 * of cubes the field names are most of the payload, and this is a wire format the browser reads once
 * into an array rather than a shape anyone works with.
 *
 * `faces` is a bitmask of the sides with nothing against them, in the order `-X +X -Y +Y -Z +Z`.
 * Decided here rather than in the browser, which would otherwise recompute it on every frame.
 *
 * `material` indexes [palette]. A palette rather than a name per voxel: a build uses tens of
 * materials and has tens of thousands of voxels, so naming each one would be most of the response.
 */
data class ShapeResponse(
    /** Blocks along one edge of a voxel. Larger for a larger build — see the detail budget. */
    val voxelSize: Int,
    val originX: Int,
    val originY: Int,
    val originZ: Int,
    val sizeX: Int,
    val sizeY: Int,
    val sizeZ: Int,
    /** How many cubes are in [voxels], which holds five numbers for each. */
    val count: Int,
    /** Voxels dropped for being enclosed on all six sides. Usually most of them. */
    val hidden: Int,
    /** Block names, most of the model first. Entry 0 is the unknown material. */
    val palette: List<String>,
    val voxels: List<Int>,
)

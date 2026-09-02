package net.integr.osmium.storage.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.constraints.Min
import net.integr.osmium.storage.model.StorageArea
import java.time.Instant

@Schema(description = "One kind of stored data, and what it is costing.")
data class StorageAreaResponse(
    val area: StorageArea,
    @field:Schema(
        description = "Everything it costs on disk: the rows, their indexes and their out-of-line " +
            "storage.",
        example = "21495808",
    )
    val totalBytes: Long,
    @field:Schema(
        description = "Space held by rows that have been deleted and not yet reclaimed. Freed by " +
            "reclaiming, not by deleting more.",
        example = "66060288",
    )
    val deadBytes: Long,
    @field:Schema(
        description = "Roughly how many rows. An estimate from the statistics collector — counting " +
            "them exactly means reading every one.",
        example = "28628",
    )
    val rows: Long,
    @field:Schema(description = "When the oldest row was written, for anything that can be purged.")
    val oldest: Instant?,
    @field:Schema(description = "Whether rows here can be deleted from the storage screen.")
    val purgeable: Boolean,
    @field:Schema(description = "The tables it is made of, for whoever is looking at the database itself.")
    val tables: List<String>,
)

@Schema(
    description = "What the deployment is storing. Sizes come from Postgres rather than from " +
        "adding up what the application thinks it wrote.",
)
data class StorageResponse(
    @field:Schema(
        description = "The size of the whole database, which is at least the sum of the areas: it " +
            "also carries the catalogue and anything no area claims.",
        example = "162529280",
    )
    val databaseBytes: Long,
    val areas: List<StorageAreaResponse>,
)

@Schema(
    description = "Deletes stored data in bulk. Space is freed as *dead* rows — reclaiming it for " +
        "the operating system is a second step.",
)
data class PurgeRequest(
    @field:Min(1)
    @field:Schema(
        description = "Keep anything written within this many days. Null deletes everything in " +
            "the area, which is a different decision and is not the default for that reason.",
        example = "30",
    )
    val keepDays: Int? = null,
)

@Schema(description = "What a purge removed.")
data class PurgeResponse(
    val area: StorageArea,
    @field:Schema(description = "Rows deleted. Exact, unlike the estimate on the way in.", example = "18402")
    val deleted: Int,
    @field:Schema(
        description = "What the area costs now. Barely lower than before a purge until the space " +
            "is reclaimed, which is the point of saying it.",
    )
    val totalBytes: Long,
)

@Schema(description = "What reclaiming recovered.")
data class ReclaimResponse(
    @field:Schema(description = "Database size before.", example = "162529280")
    val beforeBytes: Long,
    @field:Schema(description = "Database size after.", example = "31457280")
    val afterBytes: Long,
)

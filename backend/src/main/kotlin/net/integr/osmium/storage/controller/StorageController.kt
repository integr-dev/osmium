package net.integr.osmium.storage.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import net.integr.osmium.storage.dto.PurgeRequest
import net.integr.osmium.storage.dto.PurgeResponse
import net.integr.osmium.storage.dto.ReclaimResponse
import net.integr.osmium.storage.dto.StorageResponse
import net.integr.osmium.storage.model.StorageArea
import net.integr.osmium.storage.service.StorageService
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/storage")
@Tag(
    name = "Storage",
    description = "What the deployment is holding on disk, and how to hold less of it.",
)
class StorageController(private val storageService: StorageService) {

    @GetMapping
    @PreAuthorize("hasAuthority('storage.read')")
    @Operation(
        summary = "What is stored, by area.",
        description = "Sizes come from Postgres itself rather than from adding up what the " +
            "application believes it wrote. Row counts are estimates from the statistics " +
            "collector — counting them exactly means reading every row in the database.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The breakdown."),
        ApiResponse(responseCode = "403", description = "Missing node `storage.read`."),
    )
    fun breakdown(): StorageResponse = storageService.breakdown()

    /**
     * `storage.purge`, not `storage.read`: looking is safe and this is not.
     *
     * Deliberately not `DELETE` on the area. The body carries how much to keep, and a DELETE with a
     * body is the kind of request proxies and clients feel free to strip — here that would turn
     * "delete everything older than thirty days" into "delete everything".
     */
    @PostMapping("/{area}/purge")
    @PreAuthorize("hasAuthority('storage.purge')")
    @Operation(
        summary = "Delete an area's data.",
        description = "Frees the space as *dead* rows: the table keeps it and will reuse it, and " +
            "the disk does not shrink until `/api/storage/reclaim` rewrites the table. The audit " +
            "trail is not purgeable — it is the record of this having happened.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "What was deleted."),
        ApiResponse(responseCode = "400", description = "An area that cannot be purged here."),
        ApiResponse(responseCode = "403", description = "Missing node `storage.purge`."),
    )
    fun purge(
        @PathVariable area: StorageArea,
        @Valid @RequestBody request: PurgeRequest,
    ): PurgeResponse = storageService.purge(area, request)

    @PostMapping("/reclaim")
    @PreAuthorize("hasAuthority('storage.purge')")
    @Operation(
        summary = "Return deleted rows' space to the operating system.",
        description = "Rewrites every table, **locking each one exclusively while it runs**. On a " +
            "live deployment that stalls hosts reporting and browsers reading for as long as the " +
            "largest table takes. It is a separate action from purging for exactly that reason.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Database size before and after."),
        ApiResponse(responseCode = "403", description = "Missing node `storage.purge`."),
    )
    fun reclaim(): ReclaimResponse = storageService.reclaim()
}

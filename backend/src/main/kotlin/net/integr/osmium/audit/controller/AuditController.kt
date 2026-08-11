package net.integr.osmium.audit.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.servlet.http.HttpServletResponse
import net.integr.osmium.audit.dto.AuditPageResponse
import net.integr.osmium.audit.service.AuditCsv
import net.integr.osmium.audit.service.AuditService
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.Instant
import net.integr.osmium.agent.model.Agent

@RestController
@RequestMapping("/api/audit")
@Tag(name = "Audit", description = "What operators did. Agent-side events are the activity feed, not this.")
class AuditController(private val auditService: AuditService) {

    @GetMapping
    @PreAuthorize("hasAuthority('audit.read')")
    @Operation(
        summary = "One page of operator actions, newest first.",
        description = """
            Pages by cursor, not by offset: the trail grows while it is being read, so an offset
            would repeat or skip entries between requests. Send `nextCursor` from the previous
            response to continue; a null `nextCursor` means the trail ended.

            Entries are kept for 30 days by default and purged daily.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "A page of entries, oldest continuing at `nextCursor`."),
        ApiResponse(responseCode = "400", description = "Malformed `cursor`."),
        ApiResponse(responseCode = "403", description = "Missing node `audit.read`."),
    )
    fun list(
        @Parameter(description = "How many entries to return. Clamped to 1..500.")
        @RequestParam(defaultValue = "100") limit: Int,
        @Parameter(description = "`nextCursor` from the previous page. Omit for the newest entries.")
        @RequestParam(required = false) cursor: String?,
        @Parameter(description = "Narrows to entries whose account, target, detail or action matches.")
        @RequestParam(required = false) query: String?,
    ): AuditPageResponse =
        auditService.findPage(limit.coerceIn(MIN_LIMIT, MAX_LIMIT), cursor, query)

    @GetMapping("/export", produces = ["text/csv"])
    @PreAuthorize("hasAuthority('audit.export')")
    @Operation(
        summary = "The trail for a date range, as a CSV attachment.",
        description = """
            `from` is inclusive and `to` exclusive, both ISO-8601 instants, so the caller decides
            what timezone a "day" means rather than having UTC assumed for it.

            The range is capped at the moment the export starts, so a `to` in the future is not an
            error and the file cannot contain the record of its own export.

            Columns are `at,account,action,target,detail`, always in English and never translated:
            an export is read by tooling and kept as a record, so its shape cannot depend on who
            pressed the button. Every field is quoted, and a value a spreadsheet would run as a
            formula keeps its text and gains a leading apostrophe.

            Writes an audit entry of its own before any row is sent.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The CSV."),
        ApiResponse(responseCode = "400", description = "`from` is not before `to`."),
        ApiResponse(responseCode = "403", description = "Missing node `audit.export`."),
    )
    fun export(
        @Parameter(description = "Start of the range, inclusive.", example = "2026-07-12T00:00:00Z")
        @RequestParam from: Instant,
        @Parameter(description = "End of the range, exclusive.", example = "2026-08-12T00:00:00Z")
        @RequestParam to: Instant,
        response: HttpServletResponse,
    ) {
        require(from.isBefore(to)) { "`from` must be before `to`" }

        // Set before the service writes a byte: once the body has started, status and headers are
        // already on the wire and a failure can no longer be reported as one.
        response.contentType = AuditCsv.CONTENT_TYPE
        response.setHeader(
            HttpHeaders.CONTENT_DISPOSITION,
            ContentDisposition.attachment().filename(AuditCsv.fileName(from, to)).build().toString(),
        )

        auditService.exportCsv(from, to, response.writer)
    }

    private companion object {
        const val MIN_LIMIT = 1
        const val MAX_LIMIT = 500
    }
}

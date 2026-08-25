package net.integr.osmium.hostlink

import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import net.integr.osmium.build.model.BuildJobState
import net.integr.osmium.build.model.BuildSegmentState
import net.integr.osmium.build.repository.BuildJobRepository
import net.integr.osmium.build.service.SegmentBlockService
import net.integr.osmium.schematic.SegmentBlocks
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException
import java.security.MessageDigest

/**
 * The one thing a host fetches rather than being sent: the blocks in a segment it has been given.
 *
 * **Not over the socket.** `HostConnections.send` is blocking and serialised per host, so a payload
 * of any size there stalls heartbeats, vitals, chat and every command for every agent on that
 * machine — and vitals go stale after thirty seconds, which would render healthy agents as
 * unreachable while a transfer drained. The socket is the control plane; this is bulk, and bulk gets
 * its own request, where a retry is a retry rather than a dropped connection.
 *
 * **Authenticated by a ticket, not by the host's token.** That token is the credential for a whole
 * machine and every agent on it, and this is a `GET` that would carry it into access logs and
 * proxies. A ticket is a capability for exactly one segment, minted when that segment is handed out
 * and dying when the assignment does — see `V16__build_segment_ticket.sql`.
 *
 * Which is why this sits outside the Bearer chain entirely, the same way `/ws/host` does: a ticket
 * is not a JWT, and the resource server would reject it before anything here could read it.
 */
@RestController
@RequestMapping("/api/hostlink")
class SegmentController(
    private val jobs: BuildJobRepository,
    private val segments: SegmentBlockService,
) {

    /**
     * The ids in the path are **checked, not used to look anything up**.
     *
     * The ticket already names one segment, so resolving by it and then confirming the path agrees
     * means a ticket cannot be aimed at a segment it was not issued for. Getting that backwards —
     * finding by id and then comparing the ticket — is the shape that turns one leaked capability
     * into a key for the whole table.
     */
    @GetMapping("/jobs/{jobId}/segments/{segmentId}")
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The blocks, in the packed segment format."),
        ApiResponse(responseCode = "401", description = "No ticket, or one that names nothing."),
        ApiResponse(
            responseCode = "409",
            description = "The job is finished, or the segment is no longer being built.",
        ),
    )
    @Transactional(readOnly = true)
    fun blocks(
        @PathVariable jobId: Long,
        @PathVariable segmentId: Long,
        @RequestHeader(TICKET_HEADER, required = false) ticket: String?,
    ): ResponseEntity<ByteArray> {
        val presented = ticket?.trim().orEmpty()
        if (presented.isEmpty()) throw unauthorized()

        val job = jobs.findByFetchTicket(presented) ?: throw unauthorized()
        val segment = job.segments.firstOrNull { it.fetchTicket != null && matches(it.fetchTicket, presented) }
            ?: throw unauthorized()

        // The path has to describe the segment the ticket names. A mismatch is a request built from
        // two different answers, not something to reconcile in the host's favour.
        if (job.id != jobId || segment.id != segmentId) throw unauthorized()

        // The ticket outlives nothing, but a job can be paused between it being minted and used, and
        // a paused job is one somebody stopped on purpose. Said as a conflict rather than a refusal
        // to authenticate, because the host is who it says it is — the work simply is not on.
        if (job.state == BuildJobState.DONE) {
            throw ResponseStatusException(HttpStatus.CONFLICT, "This job is finished")
        }
        if (segment.state != BuildSegmentState.ASSIGNED && segment.state != BuildSegmentState.BUILDING) {
            throw ResponseStatusException(HttpStatus.CONFLICT, "This segment is not being built")
        }

        val body = segments.encode(job, segment)

        return ResponseEntity.ok()
            .header("Content-Type", SegmentBlocks.CONTENT_TYPE)
            // Nothing else may hold this: it is one agent's work, behind a single-use-shaped
            // capability, and a proxy keeping a copy is a copy the ticket no longer guards.
            .header("Cache-Control", "no-store")
            .body(body)
    }

    /**
     * Compared byte for byte in constant time.
     *
     * A ticket is a secret presented on every fetch, and the ordinary `==` on strings returns as
     * soon as two characters differ — which is a measurable difference and therefore a way to learn
     * one character at a time.
     */
    private fun matches(stored: String?, presented: String): Boolean {
        if (stored == null) return false
        return MessageDigest.isEqual(
            stored.toByteArray(Charsets.UTF_8),
            presented.toByteArray(Charsets.UTF_8),
        )
    }

    /**
     * The same answer for a missing ticket, an unknown one, and one pointed at the wrong segment.
     *
     * Distinguishing them would say whether a ticket exists, which is the only thing an attacker
     * holding a guess wants to know.
     */
    private fun unauthorized() = ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid segment ticket")

    private companion object {
        const val TICKET_HEADER = "X-Osmium-Ticket"
    }
}

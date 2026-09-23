package net.integr.osmium.build.service

import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.build.dto.CornerRequest
import net.integr.osmium.build.dto.CreateRegionRequest
import net.integr.osmium.build.dto.RegionResponse
import net.integr.osmium.build.dto.UpdateRegionRequest
import net.integr.osmium.build.dto.toResponse
import net.integr.osmium.build.model.BuildJobState
import net.integr.osmium.build.model.BuildJobType
import net.integr.osmium.build.model.RegionPlan
import net.integr.osmium.build.repository.BuildJobRepository
import net.integr.osmium.build.repository.RegionPlanRepository
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.schematic.Vec3i
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

/**
 * Region plans: a box of world, saved, so it can be worked more than once.
 *
 * **The same service `BuildService` is, for the plans with no file behind them.** A region is
 * created, edited, drawn on the map and started; what it does not have is a schematic to place,
 * substitutions to apply or a turn to apply them under.
 *
 * Corners arrive as two inclusive positions either way round, because that is what standing at two
 * ends of a hole gives you, and are stored as one half-open box - see [boxOf]. Every reader of a
 * box in Osmium already assumes that shape.
 */
@Service
@Transactional(readOnly = true)
class RegionService(
    private val repository: RegionPlanRepository,
    private val jobs: BuildJobRepository,
    private val auditService: AuditService,
    private val broker: LiveUpdateBroker,
) {
    fun findAll(): List<RegionResponse> =
        repository.findAllByOrderByCreatedAtDesc().map { it.toResponse() }

    fun find(id: Long): RegionResponse = load(id).toResponse()

    @Transactional
    fun create(request: CreateRegionRequest): RegionResponse {
        check(!repository.existsByName(request.name)) {
            "A region called '${request.name}' already exists"
        }
        require(request.type != BuildJobType.BUILD) {
            "A build comes from a schematic, so its plan is a build rather than a region"
        }

        val region = RegionPlan(
            type = request.type,
            name = request.name,
            serverAddress = request.serverAddress?.trim()?.takeIf { it.isNotEmpty() },
            dimension = request.dimension?.trim()?.takeIf { it.isNotEmpty() },
            createdBy = currentUsername(),
        )
        // Both corners or neither, which is what the request's own pair says. A region with none is
        // one somebody has named and not yet been out to measure.
        corners(request.type, request.from, request.to)?.let { (min, max) -> place(region, min, max) }

        val saved = repository.save(region)

        auditService.record(
            action = AuditAction.REGION_CREATE,
            target = saved.name,
            detail = "${saved.type.name.lowercase()}, " +
                if (saved.placed) "${saved.blocks} at ${where(saved)}" else "unplaced",
        )
        publish(saved)
        return saved.toResponse()
    }

    @Transactional
    fun update(id: Long, request: UpdateRegionRequest): RegionResponse {
        val region = load(id)
        val changes = mutableListOf<String>()

        request.name?.takeIf { it != region.name }?.let { name ->
            check(!repository.existsByNameAndIdNot(name, id)) {
                "A region called '$name' already exists"
            }
            changes += "renamed from '${region.name}'"
            region.name = name
        }

        // Unplacing first, so a request that somehow carries both ends up placed rather than in
        // whichever state the field order happened to leave it in - the rule a build plan follows.
        if (request.unplace) {
            if (region.placed) changes += "unplaced"
            region.minX = null
            region.minY = null
            region.minZ = null
            region.maxX = null
            region.maxY = null
            region.maxZ = null
        }

        // **Both corners or neither.** One corner of a new box beside one of the old describes a
        // box nobody chose, which is the kind of thing an operator finds out by flying to it.
        corners(region.type, request.from, request.to)?.let { (min, max) ->
            place(region, min, max)
            changes += "moved to ${where(region)}"
        }

        // Absent leaves it, blank clears it: JSON cannot tell a missing field from a null one, and
        // an empty string is the one value that is never a server anybody meant. The same rule a
        // build plan follows - and, as there, a plan with no server simply cannot be started yet.
        request.serverAddress?.let { asked ->
            val server = asked.trim().takeIf { it.isNotEmpty() }
            if (server != region.serverAddress) {
                changes += server?.let { "for $it" } ?: "for no server in particular"
                region.serverAddress = server
            }
        }
        request.dimension?.let { asked ->
            val dimension = asked.trim().takeIf { it.isNotEmpty() }
            if (dimension != region.dimension) {
                changes += dimension?.let { "in $it" } ?: "in no world in particular"
                region.dimension = dimension
            }
        }

        if (changes.isEmpty()) return region.toResponse()

        region.updatedAt = Instant.now()
        auditService.record(
            action = AuditAction.REGION_UPDATE,
            target = region.name,
            detail = changes.joinToString(", "),
        )
        publish(region)
        return region.toResponse()
    }

    /**
     * Removes a plan.
     *
     * **Refused while a job of it is active**, the same rule a build plan follows and for the same
     * reason: a job pins its own copy of the box, so deleting the plan under one would not disturb
     * the agents - it would cascade the job away and take the record of what they are doing with it.
     */
    @Transactional
    fun delete(id: Long) {
        val region = load(id)
        val name = region.name

        check(!jobs.existsByRegionPlanIdAndState(id, BuildJobState.ACTIVE)) {
            "'$name' is being worked; pause the job before removing the plan"
        }

        repository.delete(region)

        auditService.record(
            action = AuditAction.REGION_DELETE,
            target = name,
            detail = "Region removed; the world it described is untouched",
        )
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.REGION_REMOVED, data = mapOf("id" to id)))
    }

    fun entity(id: Long): RegionPlan = load(id)

    /**
     * Two corners an operator read off the world, as a half-open box.
     *
     * Either way round and inclusive on both ends, because that is what standing at two ends of a
     * hole gives you; the `+ 1` is what makes the far corner exclusive.
     *
     * **A survey is flattened to the height its agents fly.** Mapping is flat work, so the second Y
     * would be a number nothing reads - the lower of the two is taken as the flying height and the
     * box comes out one block thick. Which keeps one shape for every box rather than a special case
     * every reader would have to know about.
     */
    private fun corners(
        type: BuildJobType,
        from: CornerRequest?,
        to: CornerRequest?,
    ): Pair<Vec3i, Vec3i>? {
        if (from == null && to == null) return null
        val near = checkNotNull(from) { "Both corners are needed to place a region" }
        val far = checkNotNull(to) { "Both corners are needed to place a region" }

        val low = minOf(near.y, far.y)
        val high = if (type == BuildJobType.MAP) low + 1 else maxOf(near.y, far.y) + 1

        val min = Vec3i(minOf(near.x, far.x), low, minOf(near.z, far.z))
        val max = Vec3i(maxOf(near.x, far.x) + 1, high, maxOf(near.z, far.z) + 1)

        val blocks = (max.x - min.x).toLong() * (max.y - min.y) * (max.z - min.z)
        check(blocks in 1..MAX_REGION_BLOCKS) {
            "That region is $blocks blocks, and the limit is $MAX_REGION_BLOCKS"
        }
        return min to max
    }

    private fun place(region: RegionPlan, min: Vec3i, max: Vec3i) {
        region.minX = min.x
        region.minY = min.y
        region.minZ = min.z
        region.maxX = max.x
        region.maxY = max.y
        region.maxZ = max.z
    }

    private fun where(region: RegionPlan): String =
        "${region.minX}, ${region.minY}, ${region.minZ}" +
            " in ${region.dimension ?: "no world in particular"}" +
            " on ${region.serverAddress ?: "no server in particular"}"

    private fun load(id: Long): RegionPlan =
        repository.findById(id).orElseThrow { NoSuchElementException("No region $id") }

    private fun publish(region: RegionPlan) =
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.REGION_CHANGED, data = region.toResponse()))

    private fun currentUsername(): String =
        SecurityContextHolder.getContext().authentication?.name ?: "unknown"

    private companion object {
        /**
         * As many blocks as one region may cover, matching `BuildJobService.MAX_REGION_BLOCKS`.
         *
         * Checked when the plan is written rather than only when a job of it starts, so a slipped
         * digit in a coordinate is refused by the form that took it.
         */
        const val MAX_REGION_BLOCKS = 16_000_000L
    }
}

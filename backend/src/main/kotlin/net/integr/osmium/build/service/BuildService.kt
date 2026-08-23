package net.integr.osmium.build.service

import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.build.dto.BuildResponse
import net.integr.osmium.build.dto.CreateBuildRequest
import net.integr.osmium.build.dto.SubstitutionRequest
import net.integr.osmium.build.dto.UpdateBuildRequest
import net.integr.osmium.build.dto.toResponse
import net.integr.osmium.build.model.Build
import net.integr.osmium.build.model.BuildJobState
import net.integr.osmium.build.model.BuildSubstitution
import net.integr.osmium.build.repository.BuildRepository
import net.integr.osmium.build.repository.BuildJobRepository
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.schematic.repository.SchematicRepository
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

/**
 * Build plans: which schematic, where it stands, and what it is built out of.
 *
 * **Nothing derived is stored.** The offset from the schematic's own coordinates, the material
 * totals once substitutions are applied, the world bounds of each segment — all of it is arithmetic
 * over the placement and the index, so it is computed where it is read rather than written down in
 * a second place that has to be kept in step. Same reasoning as the split, which is a pure function
 * of the index and its two arguments and is never persisted.
 */
@Service
@Transactional(readOnly = true)
class BuildService(
    private val repository: BuildRepository,
    private val jobs: BuildJobRepository,
    private val schematics: SchematicRepository,
    private val auditService: AuditService,
    private val broker: LiveUpdateBroker,
) {
    fun findAll(): List<BuildResponse> =
        repository.findAllByOrderByCreatedAtDesc().map { it.toResponse() }

    fun find(id: Long): BuildResponse = load(id).toResponse()

    @Transactional
    fun create(request: CreateBuildRequest): BuildResponse {
        check(!repository.existsByName(request.name)) {
            "A build called '${request.name}' already exists"
        }

        val schematic = schematics.findById(request.schematicId).orElseThrow {
            NoSuchElementException("No schematic ${request.schematicId}")
        }

        val build = Build(
            schematic = schematic,
            name = request.name,
            createdBy = currentUsername(),
        )
        request.placement?.let { build.placeX = it.x; build.placeY = it.y; build.placeZ = it.z }
        apply(build, request.substitutions)

        val saved = repository.save(build)

        auditService.record(
            action = AuditAction.BUILD_CREATE,
            target = saved.name,
            detail = "From '${schematic.name}'" + (if (saved.placed) " at ${where(saved)}" else ", unplaced"),
        )
        publish(saved)
        return saved.toResponse()
    }

    @Transactional
    fun update(id: Long, request: UpdateBuildRequest): BuildResponse {
        val build = load(id)
        val changes = mutableListOf<String>()

        request.name?.takeIf { it != build.name }?.let { name ->
            check(!repository.existsByNameAndIdNot(name, id)) {
                "A build called '$name' already exists"
            }
            changes += "renamed from '${build.name}'"
            build.name = name
        }

        // Unplacing first, so a request that somehow carries both ends up placed rather than in
        // whichever state the field order happened to leave it in.
        if (request.unplace) {
            if (build.placed) changes += "unplaced"
            build.placeX = null
            build.placeY = null
            build.placeZ = null
        }
        request.placement?.let { placement ->
            build.placeX = placement.x
            build.placeY = placement.y
            build.placeZ = placement.z
            changes += "placed at ${where(build)}"
        }

        request.substitutions?.let { rules ->
            apply(build, rules)
            changes += "${rules.size} substitution(s)"
        }

        if (changes.isEmpty()) return build.toResponse()

        build.updatedAt = Instant.now()
        auditService.record(
            action = AuditAction.BUILD_UPDATE,
            target = build.name,
            detail = changes.joinToString(", "),
        )
        publish(build)
        return build.toResponse()
    }

    /**
     * Removes a plan.
     *
     * **Refused while a job of it is active.** A job pins its own copy of the anchor and the rules,
     * so deleting the plan underneath one would not disturb the agents placing blocks — it would
     * take away the row saying what they are building, and cascade the job away with it. Pausing is
     * a decision somebody should make deliberately rather than as a side effect of tidying up.
     */
    @Transactional
    fun delete(id: Long) {
        val build = load(id)
        val name = build.name

        check(!jobs.existsByBuildIdAndState(id, BuildJobState.ACTIVE)) {
            "'$name' is being built; pause the job before removing the plan"
        }

        repository.delete(build)

        auditService.record(
            action = AuditAction.BUILD_DELETE,
            target = name,
            detail = "Plan removed; the schematic it was built from is untouched",
        )
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.BUILD_REMOVED, data = mapOf("id" to id)))
    }

    /**
     * Brings the stored rule set to what was asked for.
     *
     * **Reconciled in place, not cleared and refilled.** Clearing the collection and adding the same
     * rules back looks like a replacement and is not: Hibernate orders inserts before deletes within
     * one flush, so the rows going in hit `build_substitutions_one_per_block` against the rows that
     * have not gone out yet — and saving an unchanged plan a second time failed. Keeping the rows
     * that are staying means a rule that did not change is not written at all, and one that only
     * changed its target is an update rather than a delete and an insert racing each other.
     *
     * A blank replacement is stored as null, so "leave it out" has one representation rather than
     * two that behave the same but do not compare equal. Two rules for the same block is refused
     * here as well as by the table: a plan that says a block becomes two different things does not
     * say what it means, and the error an operator gets should name the block rather than a
     * constraint.
     */
    private fun apply(build: Build, rules: List<SubstitutionRequest>) {
        val duplicate = rules.groupBy { blockId(it.from) }.entries.firstOrNull { it.value.size > 1 }
        require(duplicate == null) {
            "'${duplicate?.key}' is substituted twice, so it is not clear what it should become"
        }
        require(rules.none { blockId(it.from) == blockId(it.to ?: "") }) {
            "A block cannot be substituted for itself"
        }

        val wanted = rules.associate { rule ->
            blockId(rule.from) to rule.to?.let(::blockId)?.takeIf { it.isNotBlank() }
        }

        // Gone from the plan, so gone from the table. `orphanRemoval` turns this into the delete.
        build.substitutions.removeAll { it.from !in wanted }
        // Still there, possibly pointing somewhere new: an update, and a no-op when it is unchanged.
        build.substitutions.forEach { it.to = wanted[it.from] }

        val present = build.substitutions.mapTo(mutableSetOf()) { it.from }
        wanted.filterKeys { it !in present }.forEach { (from, to) ->
            build.substitutions += BuildSubstitution(build = build, from = from, to = to)
        }
    }

    /**
     * A block name with Minecraft's own namespace stripped.
     *
     * `minecraft:stone` and `stone` are the same block, and the two spellings reach here from
     * different places: a schematic's material list carries the namespace, the picker does not.
     * Stored in one form so that "one rule per block" — which the unique constraint enforces by
     * comparing strings — means what it says, and so that a rule written either way matches the
     * file. A namespace that is not Minecraft's identifies a different block and is left alone.
     */
    private fun blockId(name: String): String = name.trim().removePrefix("minecraft:")

    private fun where(build: Build) = "${build.placeX}, ${build.placeY}, ${build.placeZ}"

    private fun load(id: Long): Build =
        repository.findById(id).orElseThrow { NoSuchElementException("No build $id") }

    private fun publish(build: Build) =
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.BUILD_CHANGED, data = build.toResponse()))

    private fun currentUsername(): String =
        SecurityContextHolder.getContext().authentication?.name ?: "unknown"
}

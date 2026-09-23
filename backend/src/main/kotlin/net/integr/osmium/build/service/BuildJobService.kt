package net.integr.osmium.build.service

import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import net.integr.osmium.activity.service.ActivityService
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.build.PlacementOrder
import net.integr.osmium.build.Rotation
import net.integr.osmium.build.RegionSplit
import net.integr.osmium.build.dto.AssignSegmentRequest
import net.integr.osmium.build.dto.BuildJobResponse
import net.integr.osmium.build.dto.RegionSplitRequest
import net.integr.osmium.build.dto.StartJobRequest
import net.integr.osmium.build.dto.StartRegionJobRequest
import net.integr.osmium.build.dto.toResponse
import net.integr.osmium.build.model.Build
import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildJobAgent
import net.integr.osmium.build.model.BuildJobState
import net.integr.osmium.build.model.BuildJobSubstitution
import net.integr.osmium.build.model.BuildJobType
import net.integr.osmium.build.model.BuildSegment
import net.integr.osmium.build.model.BuildSegmentState
import net.integr.osmium.build.model.RegionPlan
import net.integr.osmium.build.repository.BuildRepository
import net.integr.osmium.build.repository.BuildJobRepository
import net.integr.osmium.build.repository.RegionPlanRepository
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
import net.integr.osmium.schematic.SplitMode
import net.integr.osmium.schematic.Vec3i
import net.integr.osmium.schematic.dto.SplitResponse
import net.integr.osmium.schematic.model.SchematicStatus
import net.integr.osmium.schematic.service.SchematicService
import org.slf4j.LoggerFactory
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import tools.jackson.databind.ObjectMapper
import java.security.SecureRandom
import java.util.UUID
import java.time.Instant

/**
 * Build jobs: a plan, frozen, being carried out.
 *
 * **This is where the pipeline stopped.** A plan says what to build and where; a split says how to
 * divide it; neither had anywhere to be recorded as *happening*. A job is that record, and it is a
 * row rather than a recomputation because progress has to attach to something with an identity.
 *
 * Three things are pinned when a job starts - the anchor, the substitutions, and the schematic -
 * and nothing about the plan reaches through afterwards. An operator editing a build while agents
 * are placing blocks from it is editing the *next* job, which is the only reading that does not
 * leave half a building under one rule set and half under another.
 *
 * **Agents are a pool, not a division.** A job holds a set of agents and a set of pieces, and
 * [schedule] is the only thing that puts one on the other. The two used to be the same act: as
 * many pieces as agents, each handed one at the start and holding it for the life of the job.
 * That shape cannot express a piece waiting for another piece, and cannot express an agent that is
 * on a job while building nothing - which is what an agent waiting for a floor under it *is*.
 */
@Service
@Transactional(readOnly = true)
class BuildJobService(
    private val jobs: BuildJobRepository,
    private val builds: BuildRepository,
    private val regions: RegionPlanRepository,
    private val agents: AgentRepository,
    private val schematics: SchematicService,
    private val activityService: ActivityService,
    private val auditService: AuditService,
    private val broker: LiveUpdateBroker,
    private val registry: HostConnections,
    private val objectMapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    fun findAll(): List<BuildJobResponse> =
        jobs.findAllByOrderByStartedAtDesc().map { it.toResponse() }

    fun findAllForBuild(buildId: Long): List<BuildJobResponse> =
        jobs.findAllByBuildIdOrderByStartedAtDesc(buildId).map { it.toResponse() }

    fun find(id: Long): BuildJobResponse = load(id).toResponse()

    /**
     * Freezes a plan and hands its pieces out.
     *
     * The order of the checks is the order an operator hits them: what is wrong with the plan
     * first, then what is wrong with the agents, then what is already running. Each one names the
     * thing it is refusing rather than the rule it is enforcing.
     */
    @Transactional
    fun start(buildId: Long, request: StartJobRequest): BuildJobResponse {
        val build = builds.findById(buildId).orElseThrow { NoSuchElementException("No build $buildId") }

        check(build.placed) {
            "'${build.name}' has not been placed, so there is nowhere to build it"
        }
        val schematic = build.schematic
        check(schematic.status == SchematicStatus.READY) {
            "'${schematic.name}' has not been read yet, so it cannot be divided"
        }

        // **The plan says where, and the crew is checked against it.** The server used to be
        // derived from whoever was ticked, which let a build placed against one world's landscape
        // go up on another because somebody chose a different agent, with nothing anywhere saying
        // so. A plan may still be *written* without a server — deciding to build comes before
        // deciding where — but it cannot be started without one, the rule a region follows.
        val meant = checkNotNull(build.serverAddress) {
            "'${build.name}' does not say which server it is for"
        }
        val world = checkNotNull(build.dimension) {
            "'${build.name}' does not say which world it is in"
        }

        val crew = resolveCrew(request.agentIds)
        val server = checkNotNull(crew.first().serverAddress)
        check(server == meant) {
            "'${build.name}' is planned for $world on $meant, and these agents are on $server"
        }

        // **Per server, not per plan.** The same tower on two servers is the case a job exists to
        // allow — it is why `builds` is its own table — and asking only about the plan refused it.
        //
        // Paused counts as in the way: it holds its crew and will be resumed, so a second job
        // beside it would end up with two sets of agents on the same blocks.
        //
        // Refused here as well as by `uq_build_jobs_active`, so the operator is told which job is
        // in the way rather than being handed a constraint violation.
        jobs.findFirstByBuildIdAndServerAddressAndStateIn(buildId, server, UNFINISHED)?.let { existing ->
            error(
                "'${build.name}' is already being built on $server" +
                    if (existing.state == BuildJobState.PAUSED) ", by a job that is paused" else "",
            )
        }

        // **How many pieces is its own question now.** It used to be the size of the crew, because
        // a piece was a share handed to an agent once. Now a piece is a unit of work that agents
        // take and finish, so there can be more of them than there are agents - which is what lets
        // a slow agent take fewer, a returning one take the next, and a build be divided finer than
        // the number of bots pointed at it.
        // Checked before anything is created. A piece is hours of an agent's work, and a sweep
        // nobody asked for is worse than a job that refused to start — so a token this backend
        // cannot read ends the request here rather than being quietly replaced by the default.
        val order = PlacementOrder.of(request.order)
            ?: error("'${request.order}' is not a placement order")
        val perPiece = request.segmentOrders.orEmpty().mapValues { (ordinal, value) ->
            PlacementOrder.of(value) ?: error("'$value' is not a placement order, for piece $ordinal")
        }

        val parts = request.parts ?: crew.size
        val split = schematics.split(checkNotNull(schematic.id), request.mode, parts)
        check(split.segments.isNotEmpty()) {
            "'${schematic.name}' has no blocks to divide"
        }

        // A placement is an anchor for the minimum corner and the schematic carries its own origin,
        // so the offset between them is what actually moves anything. Applied once, here, because
        // the host is told a box and does no transform of its own.
        //
        // The turn happens in between: a piece is taken out of the schematic's own space, turned
        // within the schematic's footprint, and then anchored — so the turned build's minimum corner
        // is the placement, whichever way round it faces. See `Rotation`.
        val originX = schematic.originX ?: 0
        val originY = schematic.originY ?: 0
        val originZ = schematic.originZ ?: 0
        val sizeX = checkNotNull(schematic.sizeX) { "'${schematic.name}' has no size yet" }
        val sizeZ = checkNotNull(schematic.sizeZ) { "'${schematic.name}' has no size yet" }
        val turns = Rotation.turnsOf(build.rotation)

        val job = BuildJob(
            type = BuildJobType.BUILD,
            name = build.name,
            build = build,
            schematic = schematic,
            serverAddress = server,
            state = BuildJobState.ACTIVE,
            splitMode = split.mode,
            requestedParts = split.requested,
            placeX = build.placeX!!,
            placeY = build.placeY!!,
            placeZ = build.placeZ!!,
            rotation = build.rotation,
            dimension = build.dimension,
            totalBlocks = split.blocks,
            createdBy = currentUsername(),
            startedAt = Instant.now(),
        )

        build.substitutions.forEach { rule ->
            job.substitutions += BuildJobSubstitution(job = job, from = rule.from, to = rule.to)
        }

        crew.forEach { agent ->
            job.pool += BuildJobAgent(
                job = job,
                agent = agent,
                agentLabel = agent.label,
                joinedAt = Instant.now(),
            )
        }

        // Made, not handed out. Every piece starts PENDING and the scheduler below does the giving,
        // so the first assignment goes through exactly the same door as the fiftieth.
        split.segments.forEach { segment ->
            val turned = Rotation.box(
                segment.minX - originX,
                segment.maxX - originX,
                segment.minZ - originZ,
                segment.maxZ - originZ,
                sizeX,
                sizeZ,
                turns,
            )
            val piece = BuildSegment(
                job = job,
                ordinal = segment.ordinal,
                minX = build.placeX!! + turned[0],
                minY = build.placeY!! + segment.minY - originY,
                minZ = build.placeZ!! + turned[2],
                maxX = build.placeX!! + turned[1],
                maxY = build.placeY!! + segment.maxY - originY,
                maxZ = build.placeZ!! + turned[3],
                blocks = segment.blocks,
                placementOrder = perPiece[segment.ordinal] ?: order,
            )
            job.segments += piece
        }

        schedule(job)

        val saved = jobs.save(job)

        auditService.record(
            action = AuditAction.BUILD_JOB_START,
            target = build.name,
            detail = "${split.segments.size} segment(s) on $server, " +
                "${split.blocks} blocks, ${split.mode.lowercase()}, " +
                "pool of ${crew.joinToString(", ") { it.label }}",
        )
        crew.forEach { agent ->
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.INFO,
                text = "Working on '${build.name}'",
            )
        }
        publish(saved)
        return saved.toResponse()
    }

    /**
     * Freezes a region plan and hands its pieces out: a box emptied, or a footprint charted.
     *
     * **The same act as [start], with a different plan behind it.** The checks are in the order an
     * operator hits them, as there: what is wrong with the plan first, then what is wrong with the
     * agents, then what is already running.
     *
     * The one thing it does not do is derive the server. A build job takes its target from its crew,
     * because a schematic is a shape that exists wherever you put it; six coordinates are not, and a
     * box typed against one world's landscape must not be dug in another because somebody ticked a
     * different agent. So the plan says where, and a crew that is somewhere else is refused.
     *
     * An excavation's order defaults to top to bottom, which is the one thing about digging that is
     * not building spelled backwards by accident: a bot that starts at the floor of a hole is
     * standing under everything it has left to take out.
     */
    @Transactional
    fun startRegion(regionId: Long, request: StartRegionJobRequest): BuildJobResponse {
        val region = regions.findById(regionId).orElseThrow {
            NoSuchElementException("No region $regionId")
        }
        val digging = region.type == BuildJobType.EXCAVATE

        // What a plan is allowed to leave open, a job is not. Both are asked here rather than of
        // the row, because writing a region down before going out to measure it is the point.
        check(region.placed) {
            "'${region.name}' has no corners yet, so there is nothing to work"
        }
        val meant = checkNotNull(region.serverAddress) {
            "'${region.name}' does not say which server those coordinates are on"
        }
        val world = checkNotNull(region.dimension) {
            "'${region.name}' does not say which world those coordinates are in"
        }

        val crew = resolveCrew(request.agentIds)
        val server = checkNotNull(crew.first().serverAddress)
        check(server == meant) {
            "'${region.name}' is in $world on $meant, and these agents are on $server"
        }

        jobs.findFirstByRegionPlanIdAndServerAddressAndStateIn(regionId, server, UNFINISHED)?.let { existing ->
            error(
                "'${region.name}' is already being worked on $server" +
                    if (existing.state == BuildJobState.PAUSED) ", by a job that is paused" else "",
            )
        }

        // Checked before anything is created, for the reason `start` checks it there: a piece is
        // hours of an agent's work, and a sweep nobody asked for is worse than a job that refused
        // to start.
        val order = PlacementOrder.of(request.order ?: if (digging) DIGGING_ORDER else PlacementOrder.DEFAULT)
            ?: error("'${request.order}' is not a placement order")
        val perPiece = request.segmentOrders.orEmpty().mapValues { (ordinal, value) ->
            PlacementOrder.of(value) ?: error("'$value' is not a placement order, for piece $ordinal")
        }

        // A slab one block thick has no height to cut, so a survey is strips over the ground
        // whatever was asked for; cutting it into rectangles would only have each agent turning
        // around more often for nothing.
        val mode = if (digging) request.mode else SplitMode.COLUMNS
        val (min, max) = boxOf(region)
        val split = RegionSplit.of(min, max, mode, request.parts ?: crew.size, topDown = digging)
        check(split.segments.isNotEmpty()) { "'${region.name}' has no region to divide" }

        val job = BuildJob(
            type = region.type,
            name = region.name,
            regionPlan = region,
            serverAddress = server,
            state = BuildJobState.ACTIVE,
            splitMode = split.mode,
            requestedParts = split.requested,
            // Pinned, like a build's anchor: a plan edited mid-job is the next job's plan.
            placeX = min.x,
            placeY = min.y,
            placeZ = min.z,
            regionMaxX = max.x,
            regionMaxY = max.y,
            regionMaxZ = max.z,
            dimension = region.dimension,
            totalBlocks = split.blocks,
            createdBy = currentUsername(),
            startedAt = Instant.now(),
        )

        crew.forEach { agent ->
            job.pool += BuildJobAgent(
                job = job,
                agent = agent,
                agentLabel = agent.label,
                joinedAt = Instant.now(),
            )
        }

        // Already in world coordinates: a region was given in them, so unlike a build there is no
        // origin to subtract, no anchor to add and no turn to apply.
        split.segments.forEach { segment ->
            job.segments += BuildSegment(
                job = job,
                ordinal = segment.ordinal,
                minX = segment.minX,
                minY = segment.minY,
                minZ = segment.minZ,
                maxX = segment.maxX,
                maxY = segment.maxY,
                maxZ = segment.maxZ,
                blocks = segment.blocks,
                placementOrder = perPiece[segment.ordinal] ?: order,
            )
        }

        schedule(job)

        val saved = jobs.save(job)

        auditService.record(
            action = AuditAction.BUILD_JOB_START,
            target = region.name,
            detail = "${region.type.name.lowercase()}: ${split.segments.size} segment(s) on $server, " +
                "${split.blocks} in ${region.dimension}, ${split.mode.lowercase()}, " +
                "pool of ${crew.joinToString(", ") { it.label }}",
        )
        crew.forEach { agent ->
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.INFO,
                text = "Working on '${region.name}'",
            )
        }
        publish(saved)
        return saved.toResponse()
    }

    /**
     * What [startRegion] would cut, without cutting it.
     *
     * **The same call the start makes**, rather than arithmetic of its own. A preview computed a
     * second way is a picture of a division nobody is going to be given, and the first time the two
     * disagreed the interface would be lying about the thing it exists to show.
     *
     * Takes a plan rather than a pair of corners now that there is always a plan: previewing a box
     * nobody has written down was only ever a step towards one.
     */
    fun previewRegion(regionId: Long, request: RegionSplitRequest): SplitResponse {
        val region = regions.findById(regionId).orElseThrow {
            NoSuchElementException("No region $regionId")
        }
        val digging = region.type == BuildJobType.EXCAVATE
        val (min, max) = boxOf(region)

        return RegionSplit.of(
            min,
            max,
            if (digging) request.mode else SplitMode.COLUMNS,
            request.parts,
            topDown = digging,
        )
    }

    /**
     * A placed region's box, refusing one that has not been measured yet.
     *
     * A plan may be written down before anybody has been out to read the coordinates — that is
     * what makes it a plan — so every path that needs the box asks for it here rather than
     * trusting six nullable columns.
     */
    private fun boxOf(region: RegionPlan): Pair<Vec3i, Vec3i> {
        val minX = checkNotNull(region.minX) {
            "'${region.name}' has no corners yet, so there is nothing to divide"
        }
        return Vec3i(minX, region.minY!!, region.minZ!!) to
            Vec3i(region.maxX!!, region.maxY!!, region.maxZ!!)
    }

    /**
     * Stops a job, keeping everything about it.
     *
     * **Pause rather than cancel.** Cancelling was a dead end: it stopped a job and left nothing to
     * do with it but delete it, so an operator performed two acts to express one, and the work that
     * had been divided and assigned could not be picked up again. A paused job keeps its segments,
     * its assignees and its counts, and [resume] is one call.
     *
     * It also **keeps holding its crew**, which is the honest reading of paused: those agents are on
     * this job. Freeing one is [release]; freeing all of them is [delete].
     */
    @Transactional
    fun pause(id: Long): BuildJobResponse {
        val job = load(id)
        check(job.state == BuildJobState.ACTIVE) { "This job is not building" }

        job.state = BuildJobState.PAUSED
        // The crew stays on it; the building stops. Without this a pause is a label on a job whose
        // agents are still placing blocks, which is the one thing it exists to prevent.
        callOff(job)

        auditService.record(
            action = AuditAction.BUILD_JOB_PAUSE,
            target = job.name,
            detail = "${job.blocksPlaced} of ${job.totalBlocks} blocks placed; the crew stays on it",
        )
        publish(job)
        return job.toResponse()
    }

    /**
     * Picks it up where it stopped.
     *
     * Nothing is recomputed: the pieces, the pool and the assignments never went anywhere.
     *
     * **Every held piece is sent out again**, which is the half this was missing. Pausing tells
     * each host to stop while the assignment stays on the row, so after a resume the rows said
     * `ASSIGNED` and `BUILDING` with nothing behind them: the bots had been called off and never
     * told to start again. The job sat at whatever percentage it had reached and never moved.
     *
     * Re-dispatching is exactly what handing the piece over is, so it goes through the same path -
     * a fresh ticket, the state back to `ASSIGNED`, and the command on its way. A piece reads as
     * assigned rather than building until its host says otherwise, which is the truth: it has just
     * been asked, and has not answered yet.
     *
     * Then a scheduling pass, because anything that came free while the job was stopped - an agent
     * that left and came back, a piece handed in - has been waiting for one.
     */
    @Transactional
    fun resume(id: Long): BuildJobResponse {
        val job = load(id)
        check(job.state == BuildJobState.PAUSED) { "This job is not paused" }

        job.state = BuildJobState.ACTIVE

        for (segment in job.segments.filter { it.live }) {
            segment.agent?.let { holder -> take(job, segment, holder) }
        }

        schedule(job)

        auditService.record(
            action = AuditAction.BUILD_JOB_RESUME,
            target = job.name,
            detail = "${job.segments.count { it.live }} of ${job.segments.size} segment(s) assigned",
        )
        publish(job)
        return job.toResponse()
    }

    /**
     * Removes a job and everything it was holding.
     *
     * **Only once it is not building.** Pausing and deleting are two acts, and collapsing them would
     * let a stray click take a live job - with its assignments - off the screen with nothing to say
     * what happened to it. Pause first, which also gives the operator the chance to resume instead.
     *
     * This is what frees the crew of a job nobody intends to finish. The trail keeps the start and
     * the pause either way, so it is a tidy-up rather than a way to erase what the fleet did.
     */
    @Transactional
    fun delete(id: Long) {
        val job = load(id)
        check(job.state != BuildJobState.ACTIVE) {
            "This job is still building; pause it before removing the record"
        }

        val name = job.name
        val placed = job.blocksPlaced
        // A deleted job is one nobody is coming back to, so anything still holding a segment is
        // told to stop before the rows saying who go away.
        callOff(job)
        jobs.delete(job)

        auditService.record(
            action = AuditAction.BUILD_JOB_DELETE,
            target = name,
            detail = "Record removed; $placed block(s) had been reported placed",
        )
        broker.publish(
            LiveUpdateEvent(type = LiveUpdateType.BUILD_JOB_REMOVED, data = mapOf("id" to id)),
        )
    }
    /** Hands a free segment to an agent, or moves one from the agent that could not build it. */
    @Transactional
    fun assign(jobId: Long, segmentId: Long, request: AssignSegmentRequest): BuildJobResponse {
        val job = load(jobId)
        // Paused as well as active: crewing up a job before resuming it is the ordinary way to fix
        // one that lost an agent, and refusing it would mean resuming into a half-manned build.
        check(job.state != BuildJobState.DONE) { "This job is finished" }

        val segment = job.segments.firstOrNull { it.id == segmentId }
            ?: throw NoSuchElementException("No segment $segmentId on job $jobId")
        check(segment.state != BuildSegmentState.DONE) { "Segment ${segment.ordinal} is already built" }

        val agent = agents.findById(request.agentId).orElseThrow {
            NoSuchElementException("No agent ${request.agentId}")
        }
        checkEligible(agent, job.serverAddress)
        // Two questions that used to be one. Being on another job is asked only of an agent not
        // already on this one - pinning a piece onto a bot already working the build is ordinary, and
        // checkFree would refuse it for being exactly where it belongs. Holding a live piece is asked
        // always: one bot cannot place two segments, whichever jobs they belong to.
        if (job.pool.none { it.agent.id == agent.id }) checkFree(agent)
        checkNotHolding(agent)

        join(job, agent)
        take(job, segment, agent)

        activityService.record(
            agent = agent,
            scope = ActivityScope.LIFECYCLE,
            severity = ActivitySeverity.INFO,
            text = "Assigned segment ${segment.ordinal} of '${job.name}'",
        )
        publish(job)
        return job.toResponse()
    }

    /**
     * Takes a segment back without blaming the agent for it.
     *
     * **Also the retry for a failed one**, which is the only route back from `FAILED`. Nothing
     * reassigns one on its own, and deliberately: the three things that genuinely fail a segment —
     * the box is in bedrock, the material does not exist on that server, something is denying the
     * placement — all fail again the same way for the next agent. Someone reads the reason, changes
     * whatever caused it, and releases it; the retry is that act rather than a loop.
     *
     * **The agent stays in the pool.** This hands back a *piece*. The agent is still on the job and
     * eligible for the next one, including this one - which is exactly what a retry wants. Taking an
     * agent off the job is [leave], and the two are separate acts now that they can be.
     */
    @Transactional
    fun release(jobId: Long, segmentId: Long): BuildJobResponse {
        val job = load(jobId)
        // Allowed while paused: taking one agent off a stopped job is how its crew is freed a piece
        // at a time, short of deleting the whole thing.
        check(job.state != BuildJobState.DONE) { "This job is finished" }

        val segment = job.segments.firstOrNull { it.id == segmentId }
            ?: throw NoSuchElementException("No segment $segmentId on job $jobId")
        // **Failed counts as still held.** The agent that could not build it has no further use
        // for the segment, but it is spoken for all the same: nothing hands it out again, and a
        // job cannot reach `DONE` while one sits there. Refusing to release it stranded the whole
        // job on one bad segment, with deleting and rebuilding as the only way out.
        check(segment.live || segment.state == BuildSegmentState.FAILED) {
            "Segment ${segment.ordinal} is not assigned to anyone"
        }

        // Read before `free` forgets it, and only for a piece somebody was actually working.
        //
        // **Releasing a failed piece is a retry**, and the agent that could not build it is usually
        // the one to try it again once whatever stopped it has been dealt with — so that case marks
        // nothing and the scheduler hands it straight back. Taking a *live* piece off an agent is
        // the opposite request: not this bot, give it to somebody else.
        val taken = if (segment.live) segment.agent else null

        free(job, segment)
        segment.releasedFrom = taken

        schedule(job)
        publish(job)
        return job.toResponse()
    }

    /**
     * Puts an agent on a job.
     *
     * Its own act, where crewing up used to be a side effect of handing somebody a piece. An operator
     * adding a third bot to a running build is saying "help with this", not "take segment 7" - which
     * one it gets is the scheduler's business and depends on what is free by the time it arrives.
     */
    @Transactional
    fun add(jobId: Long, agentId: Long): BuildJobResponse {
        val job = load(jobId)
        check(job.state != BuildJobState.DONE) { "This job is finished" }

        val agent = agents.findById(agentId).orElseThrow { NoSuchElementException("No agent $agentId") }
        checkEligible(agent, job.serverAddress)
        checkFree(agent)

        join(job, agent)
        schedule(job)

        activityService.record(
            agent = agent,
            scope = ActivityScope.LIFECYCLE,
            severity = ActivitySeverity.INFO,
            text = "Working on '${job.name}'",
        )
        publish(job)
        return job.toResponse()
    }

    /**
     * Takes an agent off a job, and whatever it was holding with it.
     *
     * The other half of [release], which hands back a piece and leaves the agent on the job. Both used
     * to be one act because there was nowhere for the distinction to live: an agent's only connection
     * to a job was the piece in its hands, so giving that up *was* leaving.
     *
     * Allowed while paused, which is how a stopped job's crew is freed one at a time short of deleting
     * it. What it was carrying goes back into the pool and is scheduled to whoever is left.
     */
    @Transactional
    fun leave(jobId: Long, agentId: Long): BuildJobResponse {
        val job = load(jobId)

        val member = job.pool.firstOrNull { it.agent.id == agentId }
            ?: throw NoSuchElementException("No agent $agentId on job $jobId")
        val agent = member.agent

        job.segments.filter { it.live && it.agent?.id == agentId }.forEach { free(job, it) }
        job.pool.remove(member)
        schedule(job)

        activityService.record(
            agent = agent,
            scope = ActivityScope.LIFECYCLE,
            severity = ActivitySeverity.INFO,
            text = "Taken off '${job.name}'",
        )
        publish(job)
        return job.toResponse()
    }

    /**
     * Everything this agent is part of, forgotten. For an agent being deleted, not one going quiet.
     *
     * A disconnect keeps the membership - the bot is coming back, and the job is still its job. A
     * deletion does not, and the rows have to go through Hibernate rather than under it: the foreign
     * key would cascade them away behind the session's back, which surfaces as a flush failure.
     */
    @Transactional
    fun forget(agent: Agent) {
        val agentId = agent.id ?: return

        // **Membership goes first.** Releasing a piece schedules it, and an agent still in the pool is
        // a candidate for the very piece it is being deleted off - which lands it back on a row that
        // is about to stop existing, and surfaces as a flush failure two layers away from the cause.
        for (job in jobs.findAllWithAgentInPool(agentId)) {
            job.pool.removeIf { it.agent.id == agentId }
            publish(job)
        }
        releaseSegmentsOf(agent)
    }

    /**
     * One agent, one piece, at any moment.
     *
     * Separate from [checkFree] since the pool arrived. That one asks whether the agent is on another
     * *job*; this asks whether its hands are full, which is a different question the moment an agent
     * can be on a job while holding nothing. `uq_build_segments_one_per_agent` is underneath both.
     */
    private fun checkNotHolding(agent: Agent) {
        val agentId = checkNotNull(agent.id)
        val holding = jobs.findAllHoldingAgent(agentId).firstOrNull() ?: return
        val piece = holding.segments.first { it.live && it.agent?.id == agentId }

        error("'${agent.label}' is already building segment ${piece.ordinal} of '${holding.name}'")
    }

    /** Idempotent, so the callers that cannot easily know need not ask. */
    private fun join(job: BuildJob, agent: Agent) {
        if (job.pool.any { it.agent.id == agent.id }) return
        job.pool += BuildJobAgent(
            job = job,
            agent = agent,
            agentLabel = agent.label,
            joinedAt = Instant.now(),
        )
    }

    /**
     * Takes back everything an agent was holding, because it is no longer in the game.
     *
     * Called from wherever an agent stops being `ONLINE`. **Back to `PENDING`, never `FAILED`**:
     * losing the builder is not failure of the work, and a segment flagged for somebody to look at
     * when all that happened is a dropped connection buries the ones that genuinely need it.
     *
     * The block count is deliberately left alone. Those blocks are still standing, and the number
     * stays the last thing anybody observed until the next agent surveys the box itself.
     */
    /**
     * Which segments this agent is in the middle of, by their ordinal.
     *
     * The question "is it safe to interrupt this agent" reduces to this one. Reported as the
     * ordinals rather than as a boolean so that a refusal can name what it is protecting - "is
     * building" tells an operator nothing they can act on, and "is building segments 3, 4" tells
     * them exactly which piece they would have broken.
     *
     * The same definition [releaseSegmentsOf] uses: a live segment on a job that has not finished.
     * A job with work left but nothing assigned to this agent is a job this agent is not in the
     * middle of, which is why membership is not the test.
     */
    fun segmentsHeldBy(agentId: Long): List<Int> =
        jobs.findAllHoldingAgent(agentId)
            .flatMap { job -> job.segments.filter { it.live && it.agent?.id == agentId } }
            .map { it.ordinal }
            .sorted()

    @Transactional
    fun releaseSegmentsOf(agent: Agent) {
        val agentId = agent.id ?: return

        for (job in jobs.findAllHoldingAgent(agentId)) {
            val released = job.segments.filter { it.live && it.agent?.id == agentId }
            if (released.isEmpty()) continue

            released.forEach { segment -> free(job, segment) }
            // The agent keeps its place in the pool - it is coming back, and this is a blip rather
            // than a resignation - but the work does not wait for it. Anyone else idle takes it now.
            schedule(job)
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.WARNING,
                text = "Left the game holding segment(s) " +
                    released.joinToString(", ") { it.ordinal.toString() } +
                    " of '${job.name}', which are free again",
            )
            publish(job)
        }
    }

    /**
     * Gives an idle agent a piece of whatever is waiting on its server.
     *
     * Called when an agent comes back into the game. Without it a reconnect left the agent standing
     * beside the build it had been on doing nothing: leaving the game released its segment, and
     * nothing ever handed one back, so an operator had to notice and reassign by hand - for every
     * agent, after every blip.
     *
     * **Only jobs this agent is actually on.** It used to take a piece of anything waiting on the
     * agent's server, which was the best available when membership was invisible: an idle agent
     * belonged to no job, so any job would do. Against a pool that would be conscription - an agent
     * nobody put on that build quietly turning up on it - so membership is the filter.
     */
    @Transactional
    fun reassignIdle(agent: Agent) {
        val agentId = agent.id ?: return
        if (agent.effectiveState() != AgentState.ONLINE) return

        for (job in jobs.findAllWithAgentInPool(agentId)) {
            val before = job.segments.count { it.live }
            schedule(job)
            if (job.segments.count { it.live } == before) continue

            val picked = job.segments.first { it.live && it.agent?.id == agentId }
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.INFO,
                text = "Back in game; picked up segment ${picked.ordinal} of '${job.name}'",
            )
            publish(job)
            return
        }
    }

    /**
     * What a host says about a segment it is building.
     *
     * **Last reported, never accumulated**, the same rule the vitals follow: a host that restarts
     * mid-segment resumes from what it can see, and adding up deltas would count those blocks
     * twice. So this writes the number rather than adding it.
     *
     * Found by segment rather than by agent. One agent holds one segment, so either would identify
     * it — but a report that arrives just after the segment was released then lands on whatever
     * that agent picked up next, which is a count from one box applied to another.
     */
    @Transactional
    fun recordProgress(
        agent: Agent,
        segmentId: Long,
        blocksPlaced: Long?,
        state: String?,
        reason: String?,
    ) {
        val job = jobs.findBySegmentId(segmentId) ?: return
        val segment = job.segments.firstOrNull { it.id == segmentId } ?: return

        // Only from whoever is holding it. A host reporting on somebody else’s segment is either
        // confused or lying, and neither is a reason to write down a number.
        if (segment.agent?.id != agent.id) {
            log.warn("{} reported on segment {}, which it does not hold", agent.label, segment.ordinal)
            return
        }
        if (!segment.live) return

        blocksPlaced?.takeIf { it >= 0 }?.let { placed ->
            // **The higher of the two, not the sum.** A host counts its own work from zero every
            // time it is handed a piece, and a piece handed over is one the new holder walks from
            // the beginning — so most of what it places is already there. Adding its count to what
            // was standing counted those blocks twice, which drove the bar to full and froze it
            // there while the bot was still working.
            //
            // Taking the maximum instead: the earlier figure stands while the newcomer is still
            // behind it, and the newcomer’s own count takes over the moment it goes past — which
            // is the point at which that count is the better answer. The number never goes
            // backwards and never claims work nobody did.
            //
            // Clamped to what the split said is there. A host that recounts generously must not be
            // able to drive a job past finished, which is a number an operator would act on.
            segment.blocksPlaced = minOf(maxOf(segment.blocksPlacedBase, placed), segment.blocks)
            segment.lastReportAt = Instant.now()
        }

        when (state?.lowercase()) {
            // Reported having started, which is the only thing that separates it from assigned.
            "building" -> segment.state = BuildSegmentState.BUILDING

            "done" -> {
                segment.state = BuildSegmentState.DONE
                // The count follows the verdict rather than the other way round: a host that says
                // it is finished has finished, and a segment reading 19,998 of 20,000 for ever
                // afterwards is a job that never completes.
                segment.blocksPlaced = segment.blocks
                segment.lastReportAt = Instant.now()
                segment.fetchTicket = null
            }

            "failed" -> {
                segment.state = BuildSegmentState.FAILED
                segment.failureReason = reason?.take(FAILURE_REASON_MAX)
                segment.fetchTicket = null

                // **A piece that is mostly built is not a piece that failed.** An agent that
                // placed nineteen thousand blocks and could not reach the last four has left
                // something worth going to look at; one that placed nothing has left nothing,
                // and the two deserve different colours. What separates them is the only thing
                // the backend knows for certain about the attempt: whether anything went down.
                val laid = segment.blocksPlaced > 0
                activityService.record(
                    agent = agent,
                    scope = ActivityScope.SYSTEM,
                    severity = if (laid) ActivitySeverity.WARNING else ActivitySeverity.ERROR,
                    text = buildString {
                        append(if (laid) "Issues building" else "Could not build")
                        append(" segment ${segment.ordinal} of '${job.name}'")
                        reason?.let { append(": $it") }
                    },
                )
            }

            else -> Unit
        }

        // The only thing that closes a job, and it can only happen here: nothing else can know a
        // segment finished.
        if (job.state == BuildJobState.ACTIVE && job.complete) {
            job.state = BuildJobState.DONE
            job.finishedAt = Instant.now()
            job.segments.forEach { it.fetchTicket = null }
            // The pool is live membership, so a finished job has none. Who built which piece is on
            // the segment and does not need this list to survive in order to say it.
            job.pool.clear()
        } else {
            // An agent that just finished a piece is an idle agent, and there may be a piece that was
            // waiting on the one it finished. This is the wavefront turning over.
            schedule(job)
        }

        publish(job)
    }

    /** Whether a plan is being executed right now, which is what makes it undeletable. */
    fun isBuilding(build: Build): Boolean =
        jobs.existsByBuildIdAndState(checkNotNull(build.id), BuildJobState.ACTIVE)

    /**
     * The crew, checked as a set rather than one at a time.
     *
     * One job is one server, and the server is *derived* from the agents rather than asked for:
     * a field for it would be a second place to say something the agents already say, and the two
     * could disagree.
     */
    private fun resolveCrew(agentIds: List<Long>): List<Agent> {
        require(agentIds.distinct().size == agentIds.size) {
            "The same agent is listed twice, so it is not clear how many are building"
        }

        val crew = agentIds.map { id ->
            agents.findById(id).orElseThrow { NoSuchElementException("No agent $id") }
        }

        val servers = crew.mapTo(mutableSetOf()) { it.serverAddress }
        check(servers.size == 1 && servers.first() != null) {
            "These agents are not all on one server, and a job builds in one world"
        }
        val server = servers.first()!!

        crew.forEach { checkEligible(it, server) }
        crew.forEach(::checkFree)
        return crew
    }

    /**
     * `effectiveState` rather than the stored one: an agent whose host has gone quiet is not
     * somewhere to send work, whatever it last reported.
     */
    private fun checkEligible(agent: Agent, server: String) {
        check(agent.effectiveState() == AgentState.ONLINE) {
            "'${agent.label}' is not in game"
        }
        check(agent.serverAddress == server) {
            "'${agent.label}' is on ${agent.serverAddress ?: "no server"}, not $server"
        }
    }

    /**
     * One agent, one job, across every build.
     *
     * A bot cannot be in two places, so two jobs means one bot walking between two sites placing half
     * of each - and the same is true of two pieces of the *same* build, which is the version that
     * looks reasonable in an interface. The refusal names the job in the way, because "already
     * building something" left an operator hunting for which.
     *
     * **Asked of the pool, not of what the agent is holding.** Those were the same question while a
     * crew was a division; they stopped being the same the moment an agent could be on a job between
     * pieces. Reading the segments would have called such an agent free and let a second job take it.
     *
     * `uq_build_job_agents_one_job_per_agent` enforces it underneath. This exists to say which.
     */
    private fun checkFree(agent: Agent) {
        val holding = jobs.findAllWithAgentInPool(checkNotNull(agent.id)).firstOrNull() ?: return
        val where = if (holding.state == BuildJobState.PAUSED) {
            "a paused job of '${holding.name}'"
        } else {
            "'${holding.name}'"
        }
        error("'${agent.label}' is on $where; take it off that job first, or delete the job")
    }

    /**
     * Puts idle members of the pool onto pieces that are waiting. The only thing that gives work.
     *
     * Called after anything that can change either side of that match: a job starting or resuming, a
     * piece finishing, a piece being handed back, an agent joining the pool or coming back into the
     * game. It is deliberately dumb - lowest ordinal first, one piece per agent - because the
     * interesting decisions are which pieces exist and which are ready, and those belong to the
     * split and the segment state rather than to this.
     *
     * **`FAILED` is not waiting.** Only `PENDING` is picked up, so a piece a host could not build
     * stays where an operator can see it instead of being handed straight to the next agent to fail
     * the same way. Releasing it is what makes it waiting again, and that is somebody's decision.
     *
     * **Nor is a piece with unfinished work beneath it** - see [BuildJob.blockers]. That is what
     * makes a vertical division safe rather than impossible, and it is why idle agents on an active
     * job are an ordinary state rather than a sign something is stuck.
     */
    private fun schedule(job: BuildJob) {
        if (job.state != BuildJobState.ACTIVE) return

        val busy = job.segments.filter { it.live }.mapNotNullTo(mutableSetOf()) { it.agent?.id }
        val idle = job.pool
            .map { it.agent }
            .filter { it.id !in busy && it.effectiveState() == AgentState.ONLINE }
        if (idle.isEmpty()) return

        val waiting = job.segments
            .filter { it.state == BuildSegmentState.PENDING && job.ready(it) }
            .sortedBy { it.ordinal }

        // Matched rather than zipped, because not every agent may have every piece: one taken from
        // an agent by an operator is not offered back to them. Lowest ordinal first, and the first
        // agent allowed to have it takes it - so a piece nobody else can reach simply waits, which
        // is what an operator asked for by releasing it.
        val free = idle.toMutableList()

        for (segment in waiting) {
            if (free.isEmpty()) break
            val agent = free.firstOrNull { it.id != segment.releasedFrom?.id } ?: continue

            free.remove(agent)
            take(job, segment, agent)
        }
    }

    /** Hands a free segment to an agent. The one place an assignment is written. */
    private fun take(job: BuildJob, segment: BuildSegment, agent: Agent) {
        segment.state = BuildSegmentState.ASSIGNED
        segment.agent = agent
        segment.agentLabel = agent.label
        // Where this holder starts counting from. Everything it reports is added to what is
        // already standing, because that is all a host can see: its own work.
        segment.blocksPlacedBase = segment.blocksPlaced
        // Handed out again, so the decision that kept one agent off it is spent - including when
        // that agent is the one being handed it, which only happens deliberately.
        segment.releasedFrom = null
        // Cleared, because it is the reason the *previous* attempt failed and this is a new one.
        segment.failureReason = null
        // A fresh capability every time, so the one the last holder was given stops working the
        // moment the work moves rather than whenever somebody remembers to expire it.
        segment.fetchTicket = newTicket()

        // **Not while the job is stopped.** Assigning is allowed on a paused job — crewing one up
        // before resuming it is the ordinary way to fix a job that lost an agent — but sending the
        // work would put a bot to building on a job an operator has stopped, which is the one
        // thing pausing exists to prevent. `resume` sends every held piece out, so the assignment
        // is honoured the moment the job is running again.
        if (job.state == BuildJobState.ACTIVE && dispatched(job)) {
            send(agent, CommandType.BUILD_SEGMENT) { segment.dispatchPayload(job) }
        }
    }

    private fun free(job: BuildJob, segment: BuildSegment) {
        // Told to stop *before* the assignment is forgotten, because the agent holding it is what
        // says where to send that. A host left building a segment nobody has is the one outcome
        // releasing exists to prevent.
        //
        // Only somebody who might still be building it: a host that reported `failed` stopped when
        // it said so, and telling it to cancel work it has already given up on is a command with
        // nothing to answer. Both other callers filter on `live` before they get here.
        if (segment.live && dispatched(job)) {
            segment.agent?.let { holder ->
                send(holder, CommandType.CANCEL_SEGMENT) { cancelPayload(job, segment) }
            }
        }

        segment.state = BuildSegmentState.PENDING
        segment.agent = null
        // The capability goes with the assignment it was minted for.
        segment.fetchTicket = null
        // Cleared with the assignment. The label survives a *deleted* agent so a finished segment
        // still says who built it; on a free segment it would read as one that is still held.
        segment.agentLabel = null
    }

    /**
     * Whether a host is told anything about this job's pieces.
     *
     * **Only builds, for now.** A host knows how to be handed a box of blocks to place and nothing
     * else, so an excavation or a mapping job is divided, crewed, scheduled and shown exactly like
     * a build - and then nothing is sent. Every piece an agent is given simply sits `ASSIGNED`.
     *
     * Said as one predicate rather than as a condition at each of the three call sites, because it
     * is one fact about the host protocol and it will stop being true in one commit.
     */
    private fun dispatched(job: BuildJob): Boolean = job.type == BuildJobType.BUILD

    private fun load(id: Long): BuildJob =
        jobs.findById(id).orElseThrow { NoSuchElementException("No job $id") }

    private fun publish(job: BuildJob) =
        broker.publish(LiveUpdateEvent(type = LiveUpdateType.BUILD_JOB_CHANGED, data = job.toResponse()))

    private fun currentUsername(): String =
        SecurityContextHolder.getContext().authentication?.name ?: "unknown"

    /**
     * Tells whoever is still building anything on this job to stop.
     *
     * Assignments are left exactly as they are: pausing keeps its crew, and a deleted job takes its
     * rows with it either way. This is only the half that reaches out to the world.
     */
    private fun callOff(job: BuildJob) {
        if (!dispatched(job)) return
        job.segments.filter { it.live }.forEach { segment ->
            segment.agent?.let { holder ->
                send(holder, CommandType.CANCEL_SEGMENT) { cancelPayload(job, segment) }
            }
        }
    }

    /**
     * Writes a command to the host that owns this agent, and does not care whether it lands.
     *
     * **Unlike every other command in Osmium, an unreachable host is not an error here.** Connect
     * and chat are an operator pressing a button and waiting for the answer, so a host that cannot
     * be reached is a 503 they should see. This is dispatch: a segment goes to an agent that is
     * already in game, and the interesting failure is not the write but the silence afterwards.
     *
     * A segment whose command was lost stays `ASSIGNED` with nothing building it, which the panel
     * shows and an operator resolves by releasing it — the same act that recovers a host that took
     * the command and then died. Failing the assignment instead would roll back a whole job start
     * because one of twelve hosts blinked.
     */
    private fun send(agent: Agent, type: String, payload: () -> Map<String, Any?>) {
        val hostId = agent.host.id ?: return
        val hostName = agent.host.name
        val label = agent.label
        val agentId = agent.id

        afterCommit {
            // **Built here, not when this was called.** A segment created in this transaction has
            // no id until it is flushed, so a payload assembled eagerly names segment 0 of job 0 —
            // which a host duly asks for and is refused. The ticket has the same shape.
            val envelope = HostEnvelope(
                id = "cmd-${UUID.randomUUID()}",
                kind = MessageKind.COMMAND,
                type = type,
                agentId = agentId,
                payload = objectMapper.valueToTree(payload()),
            )

            if (!registry.send(hostId, envelope)) {
                log.warn(
                    "Host {} took no '{}' for agent {}; the segment stays assigned with nothing on it",
                    hostName,
                    type,
                    label,
                )
            }
        }
    }

    /**
     * Runs once the transaction that decided this has actually committed.
     *
     * **A command must not describe a row the host cannot read yet.** `build_segment` carries a
     * fetch ticket that was minted in the same transaction, and a host that is quick about it asks
     * for the blocks before that transaction commits — the endpoint runs in its own transaction,
     * sees no such ticket, and answers 401. Which is exactly what happened the first time this ran
     * against a real schematic: three segments won the race and the fourth failed on a ticket that
     * was moments from existing.

     * The same reasoning covers the cancellations. Telling a host to stop is a decision that can be
     * rolled back with everything else in the transaction, and a host that has already acted on it
     * has no way to learn that it should not have.
     *
     * Outside a transaction it simply sends, which is what the scheduled reassignment does.
     */
    private fun afterCommit(action: () -> Unit) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            action()
            return
        }

        TransactionSynchronizationManager.registerSynchronization(
            object : TransactionSynchronization {
                override fun afterCommit() = action()
            },
        )
    }

    /**
     * What a host needs to start, beyond what it can fetch.
     *
     * The box and the count travel as well as being derivable from the body, so a host can size the
     * work and log something legible before it makes an HTTP call — and so a progress report has a
     * total to be read against. The ticket rides along because this command is the act that minted
     * it; asking for it separately would be a round trip for something already known.
     */
    private fun BuildSegment.dispatchPayload(job: BuildJob): Map<String, Any?> = mapOf(
        "jobId" to job.id,
        "segmentId" to id,
        "ticket" to fetchTicket,
        "min" to mapOf("x" to minX, "y" to minY, "z" to minZ),
        "max" to mapOf("x" to maxX, "y" to maxY, "z" to maxZ),
        "blocks" to blocks,
        "order" to placementOrder,
    )

    /**
     * Takes the job rather than reading `segment.job`, which is a lazy reference: this runs after
     * the transaction has closed, where following one throws.
     */
    private fun cancelPayload(job: BuildJob, segment: BuildSegment): Map<String, Any?> = mapOf(
        "jobId" to job.id,
        "segmentId" to segment.id,
    )

    /** The same shape and strength as a host enrolment secret, and read the same way. */
    private fun newTicket(): String {
        val bytes = ByteArray(TICKET_BYTES).also { SecureRandom().nextBytes(it) }
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val TICKET_BYTES = 16

        /**
         * Top to bottom, north to south, west to east. What an excavation gets when nobody says.
         *
         * The mirror of [PlacementOrder.DEFAULT] on the one axis where digging is not building in
         * reverse by coincidence: a bot that starts at the floor of a hole is standing underneath
         * everything it has left to take out.
         */
        const val DIGGING_ORDER = "y-z+x+"

        /** Written for whoever reads host logs, and truncated to what the column holds. */
        const val FAILURE_REASON_MAX = 256

        /**
         * A job that still has a claim on its build, its server and its crew.
         *
         * `DONE` is the only state that lets go of all three, which is why it is the one missing
         * here rather than `ACTIVE` being the only one present.
         */
        val UNFINISHED = listOf(BuildJobState.ACTIVE, BuildJobState.PAUSED)
    }
}

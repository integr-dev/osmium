package net.integr.osmium.build.service

import net.integr.osmium.activity.model.ActivityScope
import net.integr.osmium.activity.model.ActivitySeverity
import net.integr.osmium.activity.service.ActivityService
import net.integr.osmium.agent.model.Agent
import net.integr.osmium.agent.model.AgentState
import net.integr.osmium.agent.repository.AgentRepository
import net.integr.osmium.audit.model.AuditAction
import net.integr.osmium.audit.service.AuditService
import net.integr.osmium.build.dto.AssignSegmentRequest
import net.integr.osmium.build.dto.BuildJobResponse
import net.integr.osmium.build.dto.StartJobRequest
import net.integr.osmium.build.dto.toResponse
import net.integr.osmium.build.model.Build
import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildJobState
import net.integr.osmium.build.model.BuildJobSubstitution
import net.integr.osmium.build.model.BuildSegment
import net.integr.osmium.build.model.BuildSegmentState
import net.integr.osmium.build.repository.BuildRepository
import net.integr.osmium.build.repository.BuildJobRepository
import net.integr.osmium.hostlink.CommandType
import net.integr.osmium.hostlink.HostConnections
import net.integr.osmium.hostlink.HostEnvelope
import net.integr.osmium.hostlink.MessageKind
import net.integr.osmium.liveupdates.LiveUpdateBroker
import net.integr.osmium.liveupdates.LiveUpdateEvent
import net.integr.osmium.liveupdates.LiveUpdateType
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
 * **Nothing is dispatched yet.** Segments are assigned and stay assigned: carrying one to a host
 * needs a `build_segment` command and a way to serve the blocks, neither of which exists. What is
 * here is everything up to that point, so the missing piece is a wire message rather than a model.
 */
@Service
@Transactional(readOnly = true)
class BuildJobService(
    private val jobs: BuildJobRepository,
    private val builds: BuildRepository,
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

        val crew = resolveCrew(request.agentIds)
        val server = checkNotNull(crew.first().serverAddress)

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

        val split = schematics.split(checkNotNull(schematic.id), request.mode, crew.size)
        check(split.segments.isNotEmpty()) {
            "'${schematic.name}' has no blocks to divide"
        }

        // A placement is an anchor for the minimum corner and the schematic carries its own origin,
        // so the offset between them is what actually moves anything. Applied once, here, because
        // the host is told a box and does no transform of its own.
        val offsetX = build.placeX!! - (schematic.originX ?: 0)
        val offsetY = build.placeY!! - (schematic.originY ?: 0)
        val offsetZ = build.placeZ!! - (schematic.originZ ?: 0)

        val job = BuildJob(
            build = build,
            schematic = schematic,
            serverAddress = server,
            state = BuildJobState.ACTIVE,
            splitMode = split.mode,
            requestedParts = split.requested,
            placeX = build.placeX!!,
            placeY = build.placeY!!,
            placeZ = build.placeZ!!,
            totalBlocks = split.blocks,
            createdBy = currentUsername(),
            startedAt = Instant.now(),
        )

        build.substitutions.forEach { rule ->
            job.substitutions += BuildJobSubstitution(job = job, from = rule.from, to = rule.to)
        }

        // The split can return fewer parts than were asked for - a build three cells wide does not
        // divide between eight agents - so the pieces are zipped against the crew rather than the
        // crew being indexed by ordinal. Whoever is left over is assigned nothing, and the response
        // says so by having fewer segments than agents.
        split.segments.forEachIndexed { index, segment ->
            val piece = BuildSegment(
                job = job,
                ordinal = segment.ordinal,
                minX = segment.minX + offsetX,
                minY = segment.minY + offsetY,
                minZ = segment.minZ + offsetZ,
                maxX = segment.maxX + offsetX,
                maxY = segment.maxY + offsetY,
                maxZ = segment.maxZ + offsetZ,
                blocks = segment.blocks,
            )
            // Through the same door a reassignment uses, rather than setting the fields here as
            // well: the first assignment needs its fetch ticket exactly as much as the fifth, and
            // two places that write an assignment is one place to forget something.
            crew.getOrNull(index)?.let { agent -> take(job, piece, agent) }
            job.segments += piece
        }

        val saved = jobs.save(job)

        auditService.record(
            action = AuditAction.BUILD_JOB_START,
            target = build.name,
            detail = "${split.segments.size} segment(s) on $server, " +
                "${split.blocks} blocks, ${split.mode.lowercase()}, " +
                "assigned to ${crew.joinToString(", ") { it.label }}",
        )
        crew.forEach { agent ->
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.INFO,
                text = "Assigned to '${build.name}'",
            )
        }
        publish(saved)
        return saved.toResponse()
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
            target = job.build.name,
            detail = "${job.blocksPlaced} of ${job.totalBlocks} blocks placed; the crew stays on it",
        )
        publish(job)
        return job.toResponse()
    }

    /**
     * Picks it up where it stopped.
     *
     * Nothing is reassigned and nothing is recomputed: the segments and their assignees never went
     * anywhere. An agent that left the game while the job was paused had its segment released like
     * any other, and gets one back the moment it reconnects - see [reassignIdle].
     */
    @Transactional
    fun resume(id: Long): BuildJobResponse {
        val job = load(id)
        check(job.state == BuildJobState.PAUSED) { "This job is not paused" }

        job.state = BuildJobState.ACTIVE

        auditService.record(
            action = AuditAction.BUILD_JOB_RESUME,
            target = job.build.name,
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

        val name = job.build.name
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
        checkFree(agent)

        take(job, segment, agent)

        activityService.record(
            agent = agent,
            scope = ActivityScope.LIFECYCLE,
            severity = ActivitySeverity.INFO,
            text = "Assigned segment ${segment.ordinal} of '${job.build.name}'",
        )
        publish(job)
        return job.toResponse()
    }

    /** Takes a segment back without blaming the agent for it. */
    @Transactional
    fun release(jobId: Long, segmentId: Long): BuildJobResponse {
        val job = load(jobId)
        // Allowed while paused: taking one agent off a stopped job is how its crew is freed a piece
        // at a time, short of deleting the whole thing.
        check(job.state != BuildJobState.DONE) { "This job is finished" }

        val segment = job.segments.firstOrNull { it.id == segmentId }
            ?: throw NoSuchElementException("No segment $segmentId on job $jobId")
        check(segment.live) { "Segment ${segment.ordinal} is not assigned to anyone" }

        free(job, segment)
        publish(job)
        return job.toResponse()
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
    @Transactional
    fun releaseSegmentsOf(agent: Agent) {
        val agentId = agent.id ?: return

        for (job in jobs.findAllHoldingAgent(agentId)) {
            val released = job.segments.filter { it.live && it.agent?.id == agentId }
            if (released.isEmpty()) continue

            released.forEach { segment -> free(job, segment) }
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.WARNING,
                text = "Left the game holding segment(s) " +
                    released.joinToString(", ") { it.ordinal.toString() } +
                    " of '${job.build.name}', which are free again",
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
     * **Only what is genuinely waiting.** One segment, from an active job on this agent's own
     * server, lowest ordinal first so the build fills in the order it is meant to happen. A paused
     * job is skipped: somebody stopped it deliberately, and quietly re-crewing it would undo that.
     */
    @Transactional
    fun reassignIdle(agent: Agent) {
        val agentId = agent.id ?: return
        val server = agent.serverAddress ?: return
        if (agent.effectiveState() != AgentState.ONLINE) return
        if (jobs.findAllHoldingAgent(agentId).isNotEmpty()) return

        for (job in jobs.findAllWantingBuilders(server)) {
            val segment = job.segments
                .filter { it.state == BuildSegmentState.PENDING }
                .minByOrNull { it.ordinal }
                ?: continue

            take(job, segment, agent)
            activityService.record(
                agent = agent,
                scope = ActivityScope.LIFECYCLE,
                severity = ActivitySeverity.INFO,
                text = "Back in game; picked up segment ${segment.ordinal} of '${job.build.name}'",
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
            // Clamped to what the split said is there. A host that recounts generously must not be
            // able to drive a job past finished, which is a number an operator would act on.
            segment.blocksPlaced = minOf(placed, segment.blocks)
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
                activityService.record(
                    agent = agent,
                    scope = ActivityScope.SYSTEM,
                    severity = ActivitySeverity.ERROR,
                    text = "Could not build segment ${segment.ordinal} of '${job.build.name}'" +
                        (reason?.let { ": $it" } ?: ""),
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
     * One agent, one segment, across every job and every build.
     *
     * A bot cannot be in two places, so two segments means one bot walking between two sites placing
     * half of each - and the same is true of two segments of the *same* build, which is the version
     * that looks reasonable in an interface. The refusal names the job in the way, because "already
     * building something" left an operator hunting for which.
     *
     * `uq_build_segments_one_per_agent` enforces it underneath. This exists to say which.
     */
    private fun checkFree(agent: Agent) {
        val holding = jobs.findAllHoldingAgent(checkNotNull(agent.id)).firstOrNull() ?: return
        val where = if (holding.state == BuildJobState.PAUSED) {
            "a paused job of '${holding.build.name}'"
        } else {
            "'${holding.build.name}'"
        }
        error("'${agent.label}' is on $where; release its segment or delete that job first")
    }

    /** Hands a free segment to an agent. The one place an assignment is written. */
    private fun take(job: BuildJob, segment: BuildSegment, agent: Agent) {
        segment.state = BuildSegmentState.ASSIGNED
        segment.agent = agent
        segment.agentLabel = agent.label
        // Cleared, because it is the reason the *previous* attempt failed and this is a new one.
        segment.failureReason = null
        // A fresh capability every time, so the one the last holder was given stops working the
        // moment the work moves rather than whenever somebody remembers to expire it.
        segment.fetchTicket = newTicket()

        send(agent, CommandType.BUILD_SEGMENT) { segment.dispatchPayload(job) }
    }

    private fun free(job: BuildJob, segment: BuildSegment) {
        // Told to stop *before* the assignment is forgotten, because the agent holding it is what
        // says where to send that. A host left building a segment nobody has is the one outcome
        // releasing exists to prevent.
        segment.agent?.let { holder ->
            send(holder, CommandType.CANCEL_SEGMENT) { cancelPayload(job, segment) }
        }

        segment.state = BuildSegmentState.PENDING
        segment.agent = null
        // The capability goes with the assignment it was minted for.
        segment.fetchTicket = null
        // Cleared with the assignment. The label survives a *deleted* agent so a finished segment
        // still says who built it; on a free segment it would read as one that is still held.
        segment.agentLabel = null
    }

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

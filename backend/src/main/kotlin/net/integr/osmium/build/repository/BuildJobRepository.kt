package net.integr.osmium.build.repository

import net.integr.osmium.build.model.BuildJob
import net.integr.osmium.build.model.BuildJobState
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query

interface BuildJobRepository : JpaRepository<BuildJob, Long> {
    /** Newest first, like the build list and the schematic library. */
    fun findAllByOrderByStartedAtDesc(): List<BuildJob>

    fun findAllByBuildIdOrderByStartedAtDesc(buildId: Long): List<BuildJob>

    fun findAllByState(state: BuildJobState): List<BuildJob>

    /**
     * Whether a plan is being carried out right now, anywhere.
     *
     * The guard on deleting a build: the plan can go once nothing is executing it, and not while
     * agents are placing blocks from a copy of it.
     */
    fun existsByBuildIdAndState(buildId: Long, state: BuildJobState): Boolean

    /**
     * Whether this plan is already being built **on this server**.
     *
     * The server is half the question and leaving it out was a bug: the same tower on two servers
     * is the case a job exists to allow, and is why `builds` is its own table rather than columns
     * on the schematic. `uq_build_jobs_active` had it right; the service asked a narrower question
     * and refused first.
     *
     * **Paused counts.** A paused job is one somebody intends to come back to, still holding its
     * crew and its counts; a second job started beside it would claim the same blocks in the same
     * place, and resuming the first would then have two sets of agents building one thing.
     */
    fun findFirstByBuildIdAndServerAddressAndStateIn(
        buildId: Long,
        serverAddress: String,
        states: Collection<BuildJobState>,
    ): BuildJob?

    /**
     * The same question about a schematic, which is why a job pins one.
     *
     * Guards both deletion and re-analysis. Re-analysis matters as much: rewriting the occupancy
     * index under a frozen split leaves segments whose block counts describe cells that no longer
     * exist.
     */
    fun existsBySchematicIdAndState(schematicId: Long, state: BuildJobState): Boolean

    /**
     * The unfinished jobs an agent is currently holding a piece of.
     *
     * Asked whenever an agent leaves the game, so its segments go back to the pool rather than
     * staying assigned to something that is not playing — and before it is given new work, so it is
     * not building two things at once.
     *
     * **The job's own state is half the question**, and `DONE` is the state that does not count. A
     * paused job *does* still hold its crew: that is what paused means, and it is why resuming one
     * is a single act rather than a reassignment of everybody. A finished one holds nobody, and its
     * segments keep their assignees only so the record says who built what.
     */
    @Query(
        """
        SELECT DISTINCT r FROM BuildJob r
        JOIN r.segments s
        WHERE r.state IN ('ACTIVE', 'PAUSED')
          AND s.agent.id = :agentId
          AND s.state IN ('ASSIGNED', 'BUILDING')
        """,
    )
    fun findAllHoldingAgent(agentId: Long): List<BuildJob>

    /**
     * Jobs that could use another pair of hands on this server, oldest first.
     *
     * Read when an agent comes back into the game: a reconnect used to leave it idle beside the
     * build it had been on, because releasing its segment was the last thing anybody did about it.
     * Oldest first so a fleet returning after an outage refills the job that has been waiting
     * longest rather than whichever one happens to sort first.
     */
    @Query(
        """
        SELECT DISTINCT r FROM BuildJob r
        JOIN r.segments s
        WHERE r.state = 'ACTIVE'
          AND r.serverAddress = :server
          AND s.state = 'PENDING'
        ORDER BY r.startedAt ASC
        """,
    )
    fun findAllWantingBuilders(server: String): List<BuildJob>
}

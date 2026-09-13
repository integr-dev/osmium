package net.integr.osmium.agent.dto

import io.swagger.v3.oas.annotations.media.Schema
import jakarta.validation.Valid
import jakarta.validation.constraints.NotEmpty
import jakarta.validation.constraints.Size

/**
 * Where an agent is going, as the browser sees it.
 *
 * **Never stored.** A path is current by definition: an old position is still the only answer there
 * is about where somebody was, but an old path is simply wrong about where somebody is going. So
 * this lives in memory for as long as the journey does - see
 * [net.integr.osmium.agent.service.AgentPathStore] - and an agent that reconnects plans again
 * rather than resuming.
 */

@Schema(description = "How far a journey has got.")
enum class AgentPathState {
    @Schema(description = "A route is being searched for.")
    PLANNING,

    @Schema(description = "On its way, along the nodes last reported.")
    MOVING,

    @Schema(description = "Standing at the destination.")
    ARRIVED,

    @Schema(description = "Gave up. `reason` says why.")
    FAILED,

    @Schema(description = "Going nowhere. Also what a stop reports.")
    IDLE,
    ;

    /** Whether there is still a journey to draw. The three that are not are how one ends. */
    val live: Boolean get() = this == PLANNING || this == MOVING
}

@Schema(
    description = "An agent's current journey. Live only: it is held in memory for as long as the " +
        "journey lasts and is never written down.",
)
data class AgentPathResponse(
    val agentId: Long,
    val state: AgentPathState,

    @field:Schema(
        description = "Which world it is walking through, so a map of somewhere else does not draw " +
            "it. Null when the host did not say.",
        example = "overworld",
    )
    val dimension: String?,

    @field:Schema(description = "Where the journey ends. Null once it has ended.")
    val goal: PathGoalResponse?,

    @field:Schema(
        description = "The whole path, oldest first. Sent when the line is drawn and again on every " +
            "re-plan; an update that only moved along it leaves this out rather than resending a " +
            "few hundred points a second.",
    )
    val nodes: List<PositionResponse>?,

    @field:Schema(
        description = "Blocks the route still means to lay or break, in the order it means to. " +
            "Sent with `nodes` and again whenever one is finished, so what is drawn is what is " +
            "left to do rather than what was planned when the journey started.",
    )
    val work: List<PathWorkResponse>?,

    @field:Schema(description = "How far along `nodes` the agent has got.", example = "37")
    val progress: Int?,

    @field:Schema(description = "Why it gave up, for FAILED.", example = "there is no route there")
    val reason: String?,

    @field:Schema(
        description = "True on the one update that says the route only gets as close as the search " +
            "could, because nothing the agent can walk, climb or build reaches the goal. The agent " +
            "is still walking it. False on every other update.",
    )
    val closest: Boolean = false,
)

@Schema(description = "What the route means to do to one block.")
data class PathWorkResponse(
    @field:Schema(description = "The block itself, not a standing position.", example = "-534038")
    val x: Int,
    val y: Int,
    val z: Int,

    @field:Schema(description = "Whether the block is going in or coming out.", example = "PLACE")
    val kind: PathWorkKind,
)

@Schema(description = "Which way a planned change goes.")
enum class PathWorkKind {
    @Schema(description = "A block the agent will lay, out of what it is carrying.")
    PLACE,

    @Schema(description = "A block the agent will break to get through.")
    BREAK,
}

@Schema(
    description = "Sends an agent somewhere. The last waypoint is the destination; anything before " +
        "it is the route to take. The path itself is planned on the host, which is the only side " +
        "that can see the blocks.",
)
data class PathToRequest(
    @field:Valid
    @field:NotEmpty
    @field:Size(max = WAYPOINTS_MAX)
    @field:Schema(description = "In order, destination last.")
    val waypoints: List<PathPointRequest>,
)

@Schema(
    description = "Where a journey ends. Unlike a point on the path, this may name a column: an " +
        "operator picking somewhere off an uncharted part of the map has no height to give.",
)
data class PathGoalResponse(
    val x: Double,
    @field:Schema(description = "Null when the destination is a column rather than a point.")
    val y: Double?,
    val z: Double,
)

@Schema(description = "A point to walk to.")
data class PathPointRequest(
    val x: Double,
    /**
     * **Absent is a value, not an omission.**
     *
     * It says the height is unknown - somewhere picked off a part of the map nobody has charted -
     * and the agent is to get to that column at whatever height the ground turns out to be.
     * Defaulting it to zero would send an agent to the bottom of the world, which is a destination
     * nobody ever means.
     */
    @field:Schema(
        description = "Leave this out to name a column rather than a point: the agent gets to that " +
            "spot at whatever height the ground is. Do not send 0 to mean 'anywhere'.",
    )
    val y: Double? = null,
    val z: Double,
)

/**
 * How many waypoints one journey may name.
 *
 * Generous for a route somebody typed and tight for one nobody did. A coarse pass over stored map
 * tiles produces tens of these, not thousands, and a list past this is a mistake rather than a
 * journey.
 */
const val WAYPOINTS_MAX = 256

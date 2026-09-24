package net.integr.osmium.dashboard.dto

import io.swagger.v3.oas.annotations.media.Schema
import java.time.Instant

@Schema(description = "One point on the dashboard's charts: the fleet, each server, and each host, at one moment.")
data class DashboardSampleResponse(
    val at: Instant,
    @field:Schema(description = "Every server together.")
    val fleet: DashboardReadingResponse,
    @field:Schema(description = "The same reading per server address. A server with no agents and no builds is absent.")
    val servers: Map<String, DashboardReadingResponse>,
    @field:Schema(description = "Every enrolled host, connected or not.")
    val hosts: List<HostTrafficResponse>,
)

@Schema(description = "Agents and building, for the fleet or for one server.")
data class DashboardReadingResponse(
    @field:Schema(description = "Agents in game whose host is reachable.")
    val online: Int,
    @field:Schema(description = "Agents assigned here, in any state.")
    val agents: Int,
    @field:Schema(description = "Blocks placed across unfinished jobs.")
    val placed: Long,
    @field:Schema(description = "Blocks in unfinished jobs, placed or not.")
    val total: Long,
    @field:Schema(description = "Blocks a minute across active jobs, measured since each started. Zero while nothing is building.")
    val perMinute: Long,
)

@Schema(description = "What one host is moving, in bytes a second.")
data class HostTrafficResponse(
    val hostId: Long,
    val name: String,
    val reachable: Boolean,
    @field:Schema(description = "Backend to host, over the host link.")
    val linkSent: Long,
    @field:Schema(description = "Host to backend, over the host link.")
    val linkReceived: Long,
    @field:Schema(description = "This host's agents to their servers. Null when the host has not reported it recently.")
    val gameSent: Long?,
    @field:Schema(description = "Servers to this host's agents. Null when the host has not reported it recently.")
    val gameReceived: Long?,

    /**
     * What the host is costing the machine it runs on, as of its last heartbeat.
     *
     * All five null together: a host older than this backend reports none of them, and a partial
     * reading would draw a machine doing nothing rather than one that did not say.
     */
    @field:Schema(description = "The host process, as a percentage of one core. Two busy cores is 200.")
    val cpu: Double?,
    @field:Schema(description = "Resident bytes held for the host process.")
    val memory: Long?,
    @field:Schema(description = "The whole machine, as a percentage of all its cores together.")
    val systemCpu: Double?,
    @field:Schema(description = "Bytes in use across the machine.")
    val systemMemory: Long?,
    @field:Schema(description = "Bytes the machine has in total.")
    val systemMemoryTotal: Long?,
)

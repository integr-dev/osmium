package net.integr.osmium.map.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.map.dto.MapAreaResponse
import net.integr.osmium.map.dto.MapExtentResponse
import net.integr.osmium.map.dto.toResponse
import net.integr.osmium.map.service.MapService
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/**
 * The world as the fleet has seen it from above.
 *
 * Behind `agent.read` rather than a node of its own. Unlike the live viewer, nothing here asks a
 * host to do anything: this is what agents have already reported in the course of going about their
 * work, sitting in a table. Anyone who can see where the agents are can see the ground they covered
 * getting there.
 */
@RestController
@RequestMapping("/api/map")
@Tag(name = "Map", description = "What the fleet has charted, per server, one pixel per block column.")
class MapController(private val mapService: MapService) {

    @GetMapping("/servers")
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(
        summary = "Which servers and worlds have a map, and how much of one.",
        description = """
            One row per server **and dimension**, newest activity first: they are separate maps at
            the same coordinates, so a server that has been walked in the Overworld and the Nether
            appears twice.

            The extent is in chunk coordinates and is what a screen needs to decide where to point
            itself before it asks for any tiles.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Every server with at least one charted chunk."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
    )
    fun servers(): List<MapExtentResponse> = mapService.extents().map { it.toResponse() }

    @GetMapping("/tiles")
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(
        summary = "The tiles inside a rectangle of chunks.",
        description = """
            Coordinates are **chunks, not blocks** - divide a block coordinate by 16, rounding down.
            Both corners are included.

            `dimension` is required and is not a filter but part of the address: the worlds are
            separate places that share a coordinate system, so `0,0` in the Nether and `0,0` in the
            Overworld are different ground. Ask `/api/map/servers` for the ones that exist.

            Bounded rather than paged, because a map is drawn as an area rather than read as a list.
            At most 4096 chunks in one request, which is a kilometre square - past that, ask for a
            smaller window and draw at a coarser zoom.

            Tiles carry block *names*. What colour a block is, is a question about textures, and
            Osmium stores none: the caller holds the palette. Missing chunks are simply absent -
            nowhere in the response says a chunk has never been charted, because it is the same
            answer as one nobody has walked over yet.
        """,
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "Every charted chunk in the area."),
        ApiResponse(responseCode = "400", description = "An inside-out area, or one larger than 4096 chunks."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
    )
    fun tiles(
        @Parameter(description = "The server whose map to read.", example = "mc.example.com")
        @RequestParam server: String,
        @Parameter(
            description = "Which world, without its `minecraft:` prefix.",
            example = "overworld",
        )
        @RequestParam dimension: String,
        @Parameter(description = "West edge, in chunks.") @RequestParam minX: Int,
        @Parameter(description = "North edge, in chunks.") @RequestParam minZ: Int,
        @Parameter(description = "East edge, in chunks. Included.") @RequestParam maxX: Int,
        @Parameter(description = "South edge, in chunks. Included.") @RequestParam maxZ: Int,
    ): MapAreaResponse = MapAreaResponse(
        serverAddress = server,
        dimension = dimension,
        tiles = mapService.area(server, dimension, minX = minX, minZ = minZ, maxX = maxX, maxZ = maxZ)
            .map { it.toResponse() },
    )
}

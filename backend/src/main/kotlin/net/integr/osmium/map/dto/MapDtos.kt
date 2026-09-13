package net.integr.osmium.map.dto

import io.swagger.v3.oas.annotations.media.Schema
import net.integr.osmium.map.model.LastSeen
import net.integr.osmium.map.model.MapTile
import net.integr.osmium.map.model.SubjectKind
import net.integr.osmium.map.repository.MapExtent
import java.time.Instant
import java.util.Base64

@Schema(
    description = "One chunk of the world seen from above: 16x16 pixels, one per block column, " +
        "at the resolution of an in-game map at full zoom.",
)
data class MapTileResponse(
    @param:Schema(description = "Chunk coordinates, not block ones. Multiply by 16 for blocks.")
    val x: Int,
    val z: Int,
    /**
     * Block names, not colours.
     *
     * Which colour a block reads as is a question about textures, and Osmium stores none - the
     * interface drawing this holds the palette, derived from the same block atlas the 3D view is
     * rendered from. That is what keeps the two agreeing, and what lets a whole map be re-coloured
     * without an agent re-walking the world.
     */
    @param:Schema(
        description = "The distinct blocks on this tile's surface, indexed by `blocks`. " +
            "Names, not colours: the caller decides what a block looks like.",
        example = "[\"grass_block\",\"water\",\"sand\"]",
    )
    val palette: List<String>,
    @param:Schema(
        description = "Base64 of 256 bytes, row-major from the north-west corner, west to east " +
            "then north to south. Each byte is an index into `palette`.",
    )
    val blocks: String,
    @param:Schema(
        description = "Base64 of 256 signed 16-bit little-endian heights, matching `blocks` cell " +
            "for cell. -32768 means the column held nothing to draw. Vanilla shades a map by the " +
            "step up or down to the column to its north, which is most of what makes terrain read.",
    )
    val heights: String,
    @param:Schema(description = "The agent that last looked. Null once that agent has been deleted.")
    val agentId: Long?,
    val agentLabel: String,
    @param:Schema(description = "When it last looked. The world moves on; this says how stale a tile is.")
    val at: Instant,
)

@Schema(
    description = "A tile an agent has just charted, with the map it belongs to. Sent on the live " +
        "stream as `map-tile`, so a map on screen fills in as the fleet moves.",
)
data class MapTileChangedResponse(
    val serverAddress: String,
    val dimension: String,
    val tile: MapTileResponse,
)

@Schema(description = "The tiles inside the requested area.")
data class MapAreaResponse(
    val serverAddress: String,
    val dimension: String,
    val tiles: List<MapTileResponse>,
)

@Schema(description = "What one world of one server's map covers, in chunk coordinates.")
data class MapExtentResponse(
    val serverAddress: String,
    @param:Schema(
        description = "Which world, without its `minecraft:` prefix. The dimensions are separate " +
            "maps at the same coordinates.",
        example = "overworld",
    )
    val dimension: String,
    @param:Schema(description = "How many chunks have ever been charted here.")
    val tiles: Long,
    val minX: Int,
    val maxX: Int,
    val minZ: Int,
    val maxZ: Int,
    @param:Schema(description = "When any part of it was last seen.")
    val at: Instant,
)

@Schema(
    description = "Where somebody was the last time any agent could see them. One entry per " +
        "person per world - the last thing known, not a history of where they have been.",
)
data class LastSeenResponse(
    @param:Schema(
        description = "Whether this is one of ours. An agent is addressed by its id, because two " +
            "may share a Minecraft name; anyone else by the only name there is for them.",
    )
    val kind: SubjectKind,
    @param:Schema(description = "The agent's id written out, or the player's name.", example = "42")
    val subject: String,
    @param:Schema(description = "What to call them: an agent's label, or a player's name.")
    val label: String,
    @param:Schema(description = "What to fetch their head by. Null when neither a uuid nor a name was known.")
    val face: String?,
    val x: Double,
    val y: Double,
    val z: Double,
    @param:Schema(description = "When they were last seen there. The whole point of the row.")
    val at: Instant,
)

fun LastSeen.toResponse(): LastSeenResponse = LastSeenResponse(
    kind = kind,
    subject = subject,
    label = label,
    face = face,
    x = x,
    y = y,
    z = z,
    at = at,
)

fun MapTile.toResponse(): MapTileResponse = MapTileResponse(
    x = x,
    z = z,
    palette = palette,
    // Base64 rather than a byte array left to Jackson: the wire is the same either way, and saying
    // so in the type is what makes the published schema say `string` to a generated client.
    blocks = Base64.getEncoder().encodeToString(blocks),
    heights = Base64.getEncoder().encodeToString(heights),
    agentId = agentId,
    agentLabel = agentLabel,
    at = at,
)

fun MapExtent.toResponse(): MapExtentResponse = MapExtentResponse(
    serverAddress = serverAddress,
    dimension = dimension,
    tiles = tiles,
    minX = minX,
    maxX = maxX,
    minZ = minZ,
    maxZ = maxZ,
    at = at,
)

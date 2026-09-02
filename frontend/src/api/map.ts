import { api, errorMessage } from './client'
import type { components } from './schema'
import { TILE, chunkOf, decodeTile, type DecodedTile } from '../lib/mapTiles'

/**
 * Reading the map the fleet has charted.
 *
 * Tiles arrive as base64 and are decoded here rather than in the component, so what reaches the
 * screen is already typed arrays and never a string. What does not happen here is colouring: a tile
 * carries block names, and which colour a block reads as comes from `mapPalette`.
 */

export type MapExtentResponse = Required<components['schemas']['MapExtentResponse']>

/** How large a window the backend will answer in one request. Mirrors `MapService.MAX_TILES`. */
export const MAX_TILES = 4096

export async function listMappedServers(): Promise<MapExtentResponse[]> {
  const { data, error } = await api.GET('/api/map/servers')
  if (error) throw new Error(errorMessage(error))
  return (data ?? []) as MapExtentResponse[]
}

/** A rectangle of chunks, corners included. */
export interface Area {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/**
 * The tiles inside an area, decoded.
 *
 * A tile the backend sends but this build cannot read is dropped rather than drawn: a short array
 * would have the renderer reading past its end, which paints whatever was next in memory instead of
 * leaving an obvious gap.
 */
export async function fetchTiles(
  server: string,
  dimension: string,
  area: Area,
): Promise<DecodedTile[]> {
  const { data, error } = await api.GET('/api/map/tiles', {
    params: { query: { server, dimension, ...area } },
  })
  if (error) throw new Error(errorMessage(error))

  const tiles = data?.tiles ?? []
  return tiles.flatMap((tile) => {
    const decoded =
      tile.x === undefined || tile.z === undefined || !tile.palette || !tile.blocks || !tile.heights
        ? null
        : decodeTile({
            x: tile.x,
            z: tile.z,
            palette: tile.palette,
            blocks: tile.blocks,
            heights: tile.heights,
          })
    return decoded ? [decoded] : []
  })
}

/**
 * The area of chunks covering a rectangle of the world, with a margin.
 *
 * The margin is what stops the map tearing while it is panned: a chunk that scrolls into view has
 * already been asked for rather than being asked for once it is visible.
 */
export function areaAround(
  west: number,
  north: number,
  east: number,
  south: number,
  margin = 1,
): Area {
  return {
    minX: chunkOf(west) - margin,
    minZ: chunkOf(north) - margin,
    maxX: chunkOf(east) + margin,
    maxZ: chunkOf(south) + margin,
  }
}

/** How many chunks an area covers, which is what the request cap is measured in. */
export function tilesIn(area: Area): number {
  return (area.maxX - area.minX + 1) * (area.maxZ - area.minZ + 1)
}

/**
 * The same area, shrunk about its centre until it fits in one request.
 *
 * Shrunk rather than refused: a screen zoomed far out is asking for more world than one response
 * carries, and drawing the middle of it is a better answer than drawing nothing. The alternative -
 * splitting into several requests - is worth building when a map that large is worth reading, and
 * at that zoom a chunk is well under a pixel.
 */
export function withinCap(area: Area, cap = MAX_TILES): Area {
  if (tilesIn(area) <= cap) return area

  const width = area.maxX - area.minX + 1
  const depth = area.maxZ - area.minZ + 1
  const centreX = Math.round((area.minX + area.maxX) / 2)
  const centreZ = Math.round((area.minZ + area.maxZ) / 2)

  // A window is always an odd number of chunks across - a centre plus a half either side - so
  // scaling by the ratio and halving is not enough on its own. An 81 by 51 window is 4131 chunks
  // against a cap of 4096: the ratio is 0.996, and both halves round straight back to 40 and 25,
  // giving back the very window that did not fit. Hence the trim below, which cannot stall.
  const shrink = Math.sqrt(cap / (width * depth))
  let halfWidth = Math.max(0, Math.floor((Math.floor(width * shrink) - 1) / 2))
  let halfDepth = Math.max(0, Math.floor((Math.floor(depth * shrink) - 1) / 2))

  // Off the longer side each time, so a wide window narrows rather than becoming a strip.
  while ((2 * halfWidth + 1) * (2 * halfDepth + 1) > cap && (halfWidth > 0 || halfDepth > 0)) {
    if (halfWidth >= halfDepth) halfWidth--
    else halfDepth--
  }

  return {
    minX: centreX - halfWidth,
    maxX: centreX + halfWidth,
    minZ: centreZ - halfDepth,
    maxZ: centreZ + halfDepth,
  }
}

export { TILE }

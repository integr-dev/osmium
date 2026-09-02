import { api, errorMessage } from './client'
import type { components } from './schema'
import { TILE, decodeTile, type DecodedTile } from '../lib/mapTiles'

/**
 * Reading the map the fleet has charted.
 *
 * Tiles arrive as base64 and are decoded here rather than in the component, so what reaches the
 * screen is already typed arrays and never a string. What does not happen here is colouring: a tile
 * carries block names, and which colour a block reads as comes from `mapPalette`.
 */

export type MapExtentResponse = Required<components['schemas']['MapExtentResponse']>

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

export { TILE }

import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from './client'
import { fetchTiles } from './map'
import { AREA } from '../lib/mapTiles'

/**
 * What reaches the screen from one request.
 *
 * The decoding itself is covered in `mapTiles.spec`; what matters here is the boundary. A tile the
 * backend sends but this build cannot read has to be dropped rather than drawn - a short array
 * would have the renderer reading past its end and painting whatever was next in memory, instead of
 * leaving the obvious gap that says a chunk is missing.
 */

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

const whole = {
  x: 3,
  z: -4,
  palette: ['stone'],
  blocks: base64(new Uint8Array(AREA)),
  heights: base64(new Uint8Array(AREA * 2)),
}

/** One region, which is what the map asks for at a time. */
const region = { minX: 0, minZ: 0, maxX: 31, maxZ: 31 }

function answers(tiles: unknown[]): void {
  vi.spyOn(api, 'GET').mockResolvedValue({ data: { tiles }, error: undefined } as never)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchTiles', () => {
  it('decodes a whole tile', async () => {
    answers([whole])

    const [tile] = await fetchTiles('mc.example.com', 'overworld', region)

    expect(tile?.x).toBe(3)
    expect(tile?.z).toBe(-4)
    expect(tile?.palette).toEqual(['stone'])
    expect(tile?.heights).toHaveLength(AREA)
  })

  it('drops a tile it cannot read rather than drawing part of one', async () => {
    answers([
      whole,
      { ...whole, x: 9, blocks: base64(new Uint8Array(8)) },
      { ...whole, x: 10, palette: [] },
      { ...whole, x: 11, heights: undefined },
    ])

    const found = await fetchTiles('mc.example.com', 'overworld', region)

    expect(found.map((tile) => tile.x)).toEqual([3])
  })

  it('says nothing about an area nobody has charted', async () => {
    answers([])

    expect(await fetchTiles('mc.example.com', 'overworld', region)).toEqual([])
  })

  /** The world is addressed by server *and* dimension: they are separate maps at one coordinate. */
  it('asks for one world, by name', async () => {
    answers([])

    await fetchTiles('mc.example.com', 'the_nether', region)

    expect(api.GET).toHaveBeenCalledWith('/api/map/tiles', {
      params: { query: { server: 'mc.example.com', dimension: 'the_nether', ...region } },
    })
  })
})

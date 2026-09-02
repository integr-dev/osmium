import { describe, expect, it } from 'vitest'

import {
  AREA,
  EMPTY,
  TILE,
  UNKNOWN_DIMENSION,
  drawn,
  tileFrom,
  worldOf,
  type Column,
  type MapTile,
} from '../src/agent/map.ts'

/**
 * What a tile says about a world, read back out of it.
 *
 * `tileFrom` is the one place a block coordinate, a chunk coordinate and a pixel offset all meet,
 * and every way this can be wrong looks the same from the outside - a map that is drawn, and drawn
 * wrong. So the fakes below put a known block at a known place and the assertions read it back at
 * the pixel it should have landed on.
 */

const BOUNDS = { minY: -64, height: 384 }

const OVERWORLD = 'overworld'

/** State ids. Zero is air in every version, which is what the scan short-circuits on. */
const AIR = 0
const STONE = 1
const WATER = 2
const GLASS = 3
const BARRIER = 4

const NAMES: Record<number, string> = {
  [STONE]: 'stone',
  [WATER]: 'water',
  [GLASS]: 'glass',
  [BARRIER]: 'barrier',
}

const nameOf = (stateId: number): string | undefined => NAMES[stateId]

/** A column whose blocks are whatever `at` says, defaulting to air. */
function fakeColumn(at: (x: number, y: number, z: number) => number): Column {
  return { getBlockStateId: (pos) => at(pos.x, pos.y, pos.z) }
}

/** A flat world: solid to `top`, air above it. */
function flat(top: number, stateId = STONE): Column {
  return fakeColumn((_x, y) => (y <= top ? stateId : AIR))
}

function pixels(tile: MapTile): { block: string | undefined; height: number }[] {
  const blocks = Buffer.from(tile.blocks, 'base64')
  const heights = Buffer.from(tile.heights, 'base64')
  return Array.from({ length: AREA }, (_unused, cell) => {
    const height = heights.readInt16LE(cell * 2)
    return { block: height === EMPTY ? undefined : tile.palette[blocks[cell]!], height }
  })
}

describe('tileFrom', () => {
  it('reads one pixel per column, at the height of the surface', () => {
    const tile = tileFrom(flat(70), { x: 0, z: 0, dimension: OVERWORLD }, BOUNDS, nameOf)
    const read = pixels(tile)

    expect(read).toHaveLength(AREA)
    expect(tile.palette).toEqual(['stone'])
    expect(read.every((pixel) => pixel.block === 'stone' && pixel.height === 70)).toBe(true)
  })

  it('stops at the topmost block rather than the first solid one', () => {
    // A pane of glass over stone: a map shows the glass, because that is what is on top.
    const tile = tileFrom(
      fakeColumn((_x, y) => (y === 80 ? GLASS : y <= 70 ? STONE : AIR)),
      { x: 0, z: 0, dimension: OVERWORLD },
      BOUNDS,
      nameOf,
    )

    expect(pixels(tile)[0]).toEqual({ block: 'glass', height: 80 })
  })

  it('shows water as the surface, not the riverbed under it', () => {
    const tile = tileFrom(
      fakeColumn((_x, y) => (y <= 40 ? STONE : y <= 62 ? WATER : AIR)),
      { x: 0, z: 0, dimension: OVERWORLD },
      BOUNDS,
      nameOf,
    )

    expect(pixels(tile)[0]).toEqual({ block: 'water', height: 62 })
  })

  it('sees through blocks a player cannot see', () => {
    // A barrier over stone. Vanilla gives it no map colour, so the map shows what is under it.
    const tile = tileFrom(
      fakeColumn((_x, y) => (y === 90 ? BARRIER : y <= 70 ? STONE : AIR)),
      { x: 0, z: 0, dimension: OVERWORLD },
      BOUNDS,
      nameOf,
    )

    expect(pixels(tile)[0]).toEqual({ block: 'stone', height: 70 })
    expect(tile.palette).not.toContain('barrier')
  })

  it('leaves a column with nothing in it empty rather than guessing', () => {
    const tile = tileFrom(flat(-1000), { x: 0, z: 0, dimension: OVERWORLD }, BOUNDS, nameOf)

    expect(tile.palette).toEqual([])
    expect(pixels(tile).every((pixel) => pixel.height === EMPTY)).toBe(true)
    expect(drawn(tile)).toBe(false)
  })

  it('reaches the floor and the ceiling of the world', () => {
    const floor = tileFrom(flat(BOUNDS.minY), { x: 0, z: 0, dimension: OVERWORLD }, BOUNDS, nameOf)
    expect(pixels(floor)[0]?.height).toBe(BOUNDS.minY)

    const ceiling = BOUNDS.minY + BOUNDS.height - 1
    const roof = tileFrom(
      fakeColumn((_x, y) => (y === ceiling ? STONE : AIR)),
      { x: 0, z: 0, dimension: OVERWORLD },
      BOUNDS,
      nameOf,
    )
    expect(pixels(roof)[0]?.height).toBe(ceiling)
  })

  it('lays pixels out west to east, then north to south', () => {
    // One marked column, at chunk-local x=3 z=5. A row-major tile puts it at 5 * 16 + 3, and every
    // other layout - transposed, or counted from the far corner - puts it somewhere else.
    const tile = tileFrom(
      fakeColumn((x, y, z) => (x === 3 && z === 5 ? (y <= 80 ? WATER : AIR) : y <= 70 ? STONE : AIR)),
      { x: 0, z: 0, dimension: OVERWORLD },
      BOUNDS,
      nameOf,
    )

    const read = pixels(tile)
    expect(read[5 * TILE + 3]).toEqual({ block: 'water', height: 80 })
    expect(read.filter((pixel) => pixel.block === 'water')).toHaveLength(1)
  })

  it('reads block coordinates inside the chunk, whatever chunk it is', () => {
    // The scan must ask for 0..15, not for the chunk's world coordinates - asking for 160..175 of a
    // column that only answers for 0..15 is the off-by-one that returns an empty tile.
    const asked: number[] = []
    const column = fakeColumn((x, y) => {
      asked.push(x)
      return y <= 70 ? STONE : AIR
    })

    const tile = tileFrom(column, { x: 10, z: -7, dimension: OVERWORLD }, BOUNDS, nameOf)

    expect(tile.x).toBe(10)
    expect(tile.z).toBe(-7)
    expect(Math.min(...asked)).toBe(0)
    expect(Math.max(...asked)).toBe(TILE - 1)
  })

  it('names each block once, however many columns it covers', () => {
    const tile = tileFrom(
      fakeColumn((x, y) => (x < 8 ? (y <= 70 ? STONE : AIR) : y <= 70 ? WATER : AIR)),
      { x: 0, z: 0, dimension: OVERWORLD },
      BOUNDS,
      nameOf,
    )

    expect(tile.palette).toEqual(['stone', 'water'])
    expect(Buffer.from(tile.blocks, 'base64')).toHaveLength(AREA)
  })

  /**
   * The dimensions are separate places that share one coordinate system, so this is part of what
   * identifies a tile. Without it an agent stepping through a portal does not add to the map - it
   * overwrites it, chunk for chunk, with terrain from somewhere else entirely.
   */
  it('files the tile under the world it was read in', () => {
    const tile = tileFrom(flat(70), { x: 0, z: 0, dimension: 'the_nether' }, BOUNDS, nameOf)

    expect(tile.dimension).toBe('the_nether')
  })

  it('holds every distinct block a tile can carry', () => {
    // 256 columns can hold 256 different blocks, which is exactly what a byte index covers. One
    // more would not fit, and there is no way to ask for one more.
    const names: Record<number, string> = {}
    for (let id = 1; id <= AREA; id++) names[id] = `block_${id}`

    const tile = tileFrom(
      fakeColumn((x, y, z) => (y === 70 ? z * TILE + x + 1 : AIR)),
      { x: 0, z: 0, dimension: OVERWORLD },
      BOUNDS,
      (stateId) => names[stateId],
    )

    expect(tile.palette).toHaveLength(AREA)
    expect(new Set(pixels(tile).map((pixel) => pixel.block)).size).toBe(AREA)
  })
})

describe('worldOf', () => {
  it('drops the namespace, which is not what anything else calls a dimension', () => {
    expect(worldOf({ game: { dimension: 'minecraft:the_nether' } })).toBe('the_nether')
  })

  /**
   * The reason this takes a level name at all. mineflayer reports the dimension *type*, and a
   * server running Multiverse has any number of worlds that are all of type `overworld`. Filing
   * them under the type puts every one of them on top of the last, chunk for chunk.
   */
  it('prefers the level name over the dimension type', () => {
    expect(worldOf({ game: { dimension: 'overworld' } }, 'world_creative')).toBe('world_creative')
    expect(worldOf({ game: { dimension: 'overworld' } }, 'plotworld')).toBe('plotworld')
  })

  it('falls back to the type when the server named no level', () => {
    expect(worldOf({ game: { dimension: 'the_end' } }, undefined)).toBe('the_end')
    expect(worldOf({ game: { dimension: 'the_end' } }, '')).toBe('the_end')
    expect(worldOf({ game: { dimension: 'the_end' } }, '   ')).toBe('the_end')
  })

  /**
   * Vanilla names its levels `minecraft:overworld` and the like, which strips to exactly what the
   * type would have given - so nothing already charted moves when the level name starts arriving.
   */
  it('reads a vanilla level name as the same world the type named', () => {
    expect(worldOf({ game: { dimension: 'overworld' } }, 'minecraft:overworld')).toBe('overworld')
    expect(worldOf({ game: { dimension: 'the_nether' } }, 'minecraft:the_nether')).toBe('the_nether')
  })

  it('leaves a modded dimension that carries its own namespace alone', () => {
    expect(worldOf({ game: { dimension: 'twilightforest:twilight_forest' } }))
      .toBe('twilightforest:twilight_forest')
  })

  /**
   * Every session starts here and leaves it on the first packet that names a dimension. Filing real
   * terrain under a world that does not exist is worse than waiting a tick for the name.
   */
  it('says it does not know rather than guessing, before the server has said', () => {
    expect(worldOf({})).toBe(UNKNOWN_DIMENSION)
    expect(worldOf({ game: {} })).toBe(UNKNOWN_DIMENSION)
    expect(worldOf({ game: { dimension: '' } })).toBe(UNKNOWN_DIMENSION)
  })
})

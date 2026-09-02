import { describe, expect, it } from 'vitest'

import {
  AREA,
  EMPTY,
  SHADES,
  TILE,
  chunkOf,
  decodeTile,
  paintTile,
  shadeIndex,
  type DecodedTile,
  type TilePayload,
} from './mapTiles'

/**
 * A tile's meaning is entirely positional, so every assertion here puts something at a known place
 * and reads it back at the pixel it should have landed on. A map drawn transposed, or shaded from
 * the wrong neighbour, still looks like terrain - which is why none of this can be eyeballed.
 */

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function heightsOf(at: (cell: number) => number): Uint8Array {
  const bytes = new Uint8Array(AREA * 2)
  const view = new DataView(bytes.buffer)
  for (let cell = 0; cell < AREA; cell++) view.setInt16(cell * 2, at(cell), true)
  return bytes
}

function payload(overrides: Partial<TilePayload> = {}): TilePayload {
  return {
    x: 0,
    z: 0,
    palette: ['stone'],
    blocks: base64(new Uint8Array(AREA)),
    heights: base64(heightsOf(() => 70)),
    ...overrides,
  }
}

/** The four bytes of one pixel. */
function pixel(out: Uint8ClampedArray, x: number, z: number): number[] {
  const at = (z * TILE + x) * 4
  return [out[at]!, out[at + 1]!, out[at + 2]!, out[at + 3]!]
}

const GREEN = [0, 200, 0] as const
const BLUE = [0, 0, 200] as const

const palette = (block: string) =>
  block === 'grass_block' ? GREEN : block === 'water' ? BLUE : undefined

describe('decodeTile', () => {
  it('reads heights as signed little-endian', () => {
    const tile = decodeTile(payload({ heights: base64(heightsOf((cell) => (cell === 0 ? -59 : 300))) }))

    expect(tile?.heights[0]).toBe(-59)
    expect(tile?.heights[1]).toBe(300)
  })

  it('keeps the sentinel a sentinel rather than a large positive height', () => {
    const tile = decodeTile(payload({ heights: base64(heightsOf(() => EMPTY)) }))

    expect(tile?.heights[0]).toBe(EMPTY)
  })

  it('refuses a tile that is not the right size', () => {
    expect(decodeTile(payload({ blocks: base64(new Uint8Array(8)) }))).toBeNull()
    expect(decodeTile(payload({ heights: base64(new Uint8Array(8)) }))).toBeNull()
    expect(decodeTile(payload({ palette: [] }))).toBeNull()
  })

  it('survives a base64 string whose bytes do not start on an even offset', () => {
    // The heights are read through a DataView for exactly this: a typed array over an odd offset
    // throws, and which offset a decoded string lands on is not something the caller controls.
    const tile = decodeTile(payload())

    expect(tile?.heights).toHaveLength(AREA)
    expect(tile?.heights[AREA - 1]).toBe(70)
  })
})

describe('shadeIndex', () => {
  it('brightens a step up and darkens a step down', () => {
    expect(shadeIndex(71, 70, 0, 0)).toBe(2)
    expect(shadeIndex(69, 70, 0, 0)).toBe(0)
  })

  it('leaves level ground alone', () => {
    expect(shadeIndex(70, 70, 0, 0)).toBe(1)
    expect(shadeIndex(70, 70, 1, 0)).toBe(1)
  })

  it('reads an uncharted neighbour as level rather than as a cliff', () => {
    // A ridge along the edge of what has been explored would be an artefact of the exploring.
    expect(shadeIndex(70, undefined, 0, 0)).toBe(1)
    expect(shadeIndex(70, EMPTY, 0, 0)).toBe(1)
  })

  it('dithers a slope that sits on the threshold', () => {
    // Three quarters of a block is inside vanilla's dead band, and the parity term is what pushes
    // alternating pixels either side of it - which is the stippled edge a Minecraft map has.
    const even = shadeIndex(70.75, 70, 0, 0)
    const odd = shadeIndex(70.75, 70, 1, 0)

    expect(even).not.toBe(odd)
  })
})

describe('paintTile', () => {
  const flat = (block: string, height = 70): DecodedTile => ({
    x: 0,
    z: 0,
    palette: [block],
    blocks: new Uint8Array(AREA),
    heights: Int16Array.from({ length: AREA }, () => height),
  })

  it('paints every column of a flat tile in its block colour', () => {
    const out = new Uint8ClampedArray(AREA * 4)
    paintTile(flat('grass_block'), undefined, palette, out)

    const shade = SHADES[1]!
    expect(pixel(out, 0, 0)).toEqual([0, Math.round(200 * shade), 0, 255])
    expect(pixel(out, TILE - 1, TILE - 1)).toEqual([0, Math.round(200 * shade), 0, 255])
  })

  it('lays pixels out west to east, then north to south', () => {
    const tile = flat('grass_block')
    tile.palette = ['grass_block', 'water']
    tile.blocks[5 * TILE + 3] = 1

    const out = new Uint8ClampedArray(AREA * 4)
    paintTile(tile, undefined, palette, out)

    expect(pixel(out, 3, 5)[2]).toBeGreaterThan(0)
    expect(pixel(out, 5, 3)[2]).toBe(0)
  })

  it('leaves an empty column transparent rather than filling it', () => {
    const tile = flat('grass_block')
    tile.heights[0] = EMPTY

    const out = new Uint8ClampedArray(AREA * 4)
    paintTile(tile, undefined, palette, out)

    expect(pixel(out, 0, 0)[3]).toBe(0)
    expect(pixel(out, 1, 0)[3]).toBe(255)
  })

  it('leaves a block it has no colour for transparent, which is how air stays air', () => {
    const out = new Uint8ClampedArray(AREA * 4)
    paintTile(flat('some_block_from_the_future'), undefined, palette, out)

    expect(pixel(out, 0, 0)[3]).toBe(0)
  })

  it('shades the top row against the tile to the north, not against itself', () => {
    // Without the neighbour's edge every tile is flat along its northern border, and the map is
    // drawn in visible squares.
    const tile = flat('grass_block', 80)
    const north = Int16Array.from({ length: AREA }, () => 70)

    const shaded = new Uint8ClampedArray(AREA * 4)
    paintTile(tile, north, palette, shaded)

    const alone = new Uint8ClampedArray(AREA * 4)
    paintTile(tile, undefined, palette, alone)

    expect(pixel(shaded, 0, 0)[1]).toBeGreaterThan(pixel(alone, 0, 0)[1]!)
  })

  it('reads the neighbour from the southern edge of the tile above', () => {
    // The row that touches this tile is the last one of the one above, not its first.
    const tile = flat('grass_block', 80)
    const north = Int16Array.from({ length: AREA }, (_unused, cell) => (cell >= AREA - TILE ? 90 : 70))

    const out = new Uint8ClampedArray(AREA * 4)
    paintTile(tile, north, palette, out)

    // 80 under a neighbour at 90 is a step down, which is the darkest of the three.
    expect(pixel(out, 0, 0)[1]).toBe(Math.round(200 * SHADES[0]!))
  })
})

describe('chunkOf', () => {
  it('floors, so a block west of the origin is in the chunk west of it', () => {
    expect(chunkOf(0)).toBe(0)
    expect(chunkOf(15)).toBe(0)
    expect(chunkOf(16)).toBe(1)
    expect(chunkOf(-1)).toBe(-1)
    expect(chunkOf(-16)).toBe(-1)
    expect(chunkOf(-17)).toBe(-2)
  })
})

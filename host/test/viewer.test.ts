import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { chunkPos, coalesce, FRAME_VERSION, frame, GZIP_THRESHOLD, spiral, within, type ViewerEvent } from '../src/agent/viewer.ts'

const entity = (id: number, x: number): ViewerEvent => ({ name: 'entity', data: { id, pos: { x, y: 0, z: 0 } } })
const block = (x: number, stateId: number): ViewerEvent => ({ name: 'blockUpdate', data: { pos: { x, y: 0, z: 0 }, stateId } })
const load = (x: number, z: number): ViewerEvent => ({ name: 'loadChunk', data: { x, z, chunk: '{}' } })
const unload = (x: number, z: number): ViewerEvent => ({ name: 'unloadChunk', data: { x, z } })

function bodyOf(buffer: Buffer): ViewerEvent[] {
  const gzipped = (buffer.readUInt8(1) & 0x01) === 0x01
  const body = buffer.subarray(6)
  return JSON.parse((gzipped ? gunzipSync(body) : body).toString('utf8')) as ViewerEvent[]
}

describe('coalesce', () => {
  it('keeps only the last update for an entity', () => {
    expect(coalesce([entity(1, 0), entity(1, 5), entity(1, 9)])).toEqual([entity(1, 9)])
  })

  it('keeps entities apart from one another', () => {
    const batch = [entity(1, 0), entity(2, 0), entity(1, 5)]
    expect(coalesce(batch)).toEqual([entity(2, 0), entity(1, 5)])
  })

  it('keeps the surviving update in its latest position, not its first', () => {
    // The renderer applies these in order. A superseded update that kept the earlier slot would
    // reorder it against everything that happened in between.
    const batch = [entity(1, 0), block(7, 2), entity(1, 5)]
    expect(coalesce(batch)).toEqual([block(7, 2), entity(1, 5)])
  })

  it('keeps only the last change to one block', () => {
    expect(coalesce([block(3, 1), block(3, 2)])).toEqual([block(3, 2)])
  })

  it('keeps changes to different blocks', () => {
    expect(coalesce([block(3, 1), block(4, 1)])).toHaveLength(2)
  })

  it('lets an unload supersede the load of the same column', () => {
    expect(coalesce([load(0, 0), unload(0, 0)])).toEqual([unload(0, 0)])
  })

  it('lets a load supersede the unload of the same column', () => {
    expect(coalesce([unload(0, 0), load(0, 0)])).toEqual([load(0, 0)])
  })

  it('leaves different columns alone', () => {
    expect(coalesce([load(0, 0), load(16, 0)])).toHaveLength(2)
  })

  it('folds a spawn into the movement that supersedes it, so the size is not lost', () => {
    // The spawn is the only update that ever states name, width and height; every movement after it
    // carries a position and nothing else. Dropping it leaves the renderer building a mesh out of
    // undefined, which reaches the screen as a bounding sphere of NaN.
    const spawn: ViewerEvent = {
      name: 'entity',
      data: { id: 1, name: 'player', username: 'notch', width: 0.6, height: 1.8, pos: { x: 0, y: 0, z: 0 } },
    }
    const moved: ViewerEvent = { name: 'entity', data: { id: 1, pos: { x: 5, y: 0, z: 0 }, yaw: 1, pitch: 0 } }

    expect(coalesce([spawn, moved])).toEqual([
      {
        name: 'entity',
        data: { id: 1, name: 'player', username: 'notch', width: 0.6, height: 1.8, pos: { x: 5, y: 0, z: 0 }, yaw: 1, pitch: 0 },
      },
    ])
  })

  it('does not fold one entity into another', () => {
    const first: ViewerEvent = { name: 'entity', data: { id: 1, width: 0.6, pos: { x: 0, y: 0, z: 0 } } }
    const second: ViewerEvent = { name: 'entity', data: { id: 2, pos: { x: 9, y: 0, z: 0 } } }

    expect(coalesce([first, second])).toEqual([first, second])
  })

  it('keeps a deletion rather than the movement before it', () => {
    const deleted: ViewerEvent = { name: 'entity', data: { id: 1, delete: true } }
    expect(coalesce([entity(1, 3), deleted])).toEqual([deleted])
  })

  it('keeps one position, the newest', () => {
    const first: ViewerEvent = { name: 'position', data: { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 } }
    const second: ViewerEvent = { name: 'position', data: { pos: { x: 1, y: 0, z: 0 }, yaw: 1, pitch: 0 } }
    expect(coalesce([first, second])).toEqual([second])
  })

  it('passes an empty batch through', () => {
    expect(coalesce([])).toEqual([])
  })
})

describe('frame', () => {
  it('states the layout version and the agent it is about', () => {
    const buffer = frame(42, [entity(1, 0)])
    expect(buffer.readUInt8(0)).toBe(FRAME_VERSION)
    expect(buffer.readUInt32BE(2)).toBe(42)
  })

  it('leaves a small batch uncompressed', () => {
    const buffer = frame(1, [entity(1, 0)])
    expect(buffer.readUInt8(1) & 0x01).toBe(0)
    expect(bodyOf(buffer)).toEqual([entity(1, 0)])
  })

  it('compresses a batch past the threshold, and it still reads back', () => {
    const big: ViewerEvent = { name: 'loadChunk', data: { x: 0, z: 0, chunk: 'a'.repeat(GZIP_THRESHOLD * 2) } }
    const buffer = frame(7, [big])
    expect(buffer.readUInt8(1) & 0x01).toBe(1)
    expect(bodyOf(buffer)).toEqual([big])
  })

  it('is worth compressing: a chunk column is far smaller on the wire', () => {
    // The whole reason the flag exists. Chunk JSON repeats block names, so it collapses hard.
    const column: ViewerEvent = { name: 'loadChunk', data: { x: 0, z: 0, chunk: JSON.stringify(Array(4000).fill('minecraft:stone')) } }
    const raw = Buffer.from(JSON.stringify([column]), 'utf8').length
    expect(frame(1, [column]).length).toBeLessThan(raw / 10)
  })

  it('survives an agent id past the signed range', () => {
    expect(frame(4_000_000_000, []).readUInt32BE(2)).toBe(4_000_000_000)
  })
})

describe('spiral', () => {
  it('covers the square once', () => {
    const positions = spiral(6)
    expect(positions).toHaveLength(12 * 12)
    expect(new Set(positions.map((p) => `${p.x},${p.z}`)).size).toBe(12 * 12)
  })

  it('starts at the middle, so the nearest column is drawn first', () => {
    expect(spiral(6)[0]).toEqual({ x: 0, z: 0 })
  })

  it('walks outwards', () => {
    const distances = spiral(4).map((p) => Math.max(Math.abs(p.x), Math.abs(p.z)))
    // Not strictly sorted - a ring is walked before the next begins, which is all that matters.
    expect(distances[0]).toBe(0)
    expect(Math.max(...distances.slice(0, 9))).toBeLessThanOrEqual(1)
  })
})

describe('within', () => {
  it('accepts every column the spiral asks for', () => {
    // The invariant that matters, and the one that broke: the walk and the check have to agree on
    // where the view ends. A symmetric bound rejects the +radius edge the spiral still produces,
    // so two whole strips are generated, refused, and never drawn.
    const centre = { x: 100, z: -50 }

    for (const radius of [1, 2, 6, 8]) {
      const refused = spiral(radius)
        .map((offset) => ({ x: centre.x + offset.x, z: centre.z + offset.z }))
        .filter((at) => !within(centre, at, radius))

      expect(refused, `radius ${radius} refused ${refused.length} of its own columns`).toEqual([])
    }
  })

  it('reaches the far edge, which is +radius', () => {
    expect(within({ x: 0, z: 0 }, { x: 6, z: 6 }, 6)).toBe(true)
  })

  it('stops one short on the near edge, which is -radius', () => {
    expect(within({ x: 0, z: 0 }, { x: -6, z: 0 }, 6)).toBe(false)
    expect(within({ x: 0, z: 0 }, { x: -5, z: 0 }, 6)).toBe(true)
  })

  it('excludes what is past the edge', () => {
    expect(within({ x: 0, z: 0 }, { x: 7, z: 0 }, 6)).toBe(false)
    expect(within({ x: 0, z: 0 }, { x: 0, z: 7 }, 6)).toBe(false)
  })

  it('holds away from the origin, where the signs differ', () => {
    expect(within({ x: -100, z: -100 }, { x: -94, z: -94 }, 6)).toBe(true)
    expect(within({ x: -100, z: -100 }, { x: -106, z: -100 }, 6)).toBe(false)
  })
})

describe('chunkPos', () => {
  it('floors towards negative infinity, not towards zero', () => {
    // -1 is in chunk -1, not chunk 0. Truncation here puts the agent a chunk east of itself in
    // every negative quadrant, which is most of a long-lived world.
    expect(chunkPos({ x: -1, y: 0, z: -1 })).toEqual({ x: -1, z: -1 })
    expect(chunkPos({ x: -16, y: 0, z: -16 })).toEqual({ x: -1, z: -1 })
    expect(chunkPos({ x: -17, y: 0, z: -17 })).toEqual({ x: -2, z: -2 })
  })

  it('agrees with itself on the positive side', () => {
    expect(chunkPos({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, z: 0 })
    expect(chunkPos({ x: 15.9, y: 0, z: 15.9 })).toEqual({ x: 0, z: 0 })
    expect(chunkPos({ x: 16, y: 0, z: 16 })).toEqual({ x: 1, z: 1 })
  })
})

import { describe, expect, it } from 'vitest'

import {
  CLEARANCE,
  freed,
  hullAt,
  HULL_HEIGHT,
  HULL_WIDTH,
  MOST,
  type Box,
} from '../src/agent/unembed.ts'

/** One whole block, as a box in world coordinates. */
function block(x: number, y: number, z: number): Box {
  return { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 }
}

/**
 * Getting back out of a block.
 *
 * The bug this exists for is that `prismarine-physics` will not: its collision resolution clamps
 * only when the hull is already clear of the box, so an overlap of any size is permanent and the
 * agent goes on transmitting positions inside a wall until a server refuses them all.
 *
 * Two properties matter more than the arithmetic. **Flush is not overlap** - standing against a
 * wall is what an agent does all day, and a correction that fired on contact would fight the physics
 * every tick. And **the way out is the shortest one** - a hull that has clipped a wall comes back
 * out sideways rather than being launched over it.
 */
describe('getting out of a block', () => {
  it('says nothing about an agent standing in the open', () => {
    expect(freed({ x: 0.5, y: 64, z: 0.5 }, [])).toBeUndefined()
  })

  /** The ordinary case, every tick, for every agent: standing on the ground. */
  it('leaves an agent resting on a floor alone', () => {
    expect(freed({ x: 0.5, y: 64, z: 0.5 }, [block(0, 63, 0)])).toBeUndefined()
  })

  /** The case a correction must not touch: pressed against a wall, exactly touching it. */
  it('leaves an agent flush against a wall alone', () => {
    // Hull spans x 0.0 to 0.6; the block starts at x = -1 and ends at 0. Touching, not overlapping.
    expect(freed({ x: 0.3, y: 64, z: 0.5 }, [block(-1, 64, 0)])).toBeUndefined()
  })

  it('pushes a hull that has clipped into a wall back out along that axis', () => {
    // Four millimetres in: hull minX is -0.004 where the block's face is 0.
    const out = freed({ x: 0.296, y: 64, z: 0.5 }, [block(-1, 64, 0)])

    expect(out).toBeDefined()
    expect(out!.at.y).toBe(64)
    expect(out!.at.z).toBe(0.5)
    // Clear of the face rather than flush with it, so the next tick's arithmetic cannot put it back.
    expect(hullAt(out!.at).minX).toBeCloseTo(CLEARANCE, 6)
  })

  it('comes out sideways rather than over the top', () => {
    // Barely into a wall beside it: going up would mean climbing a whole block.
    const out = freed({ x: 0.29, y: 64, z: 0.5 }, [block(-1, 64, 0)])

    expect(out).toBeDefined()
    expect(out!.at.x).toBeGreaterThan(0.29)
    expect(out!.at.y).toBe(64)
  })

  it('lifts a hull that has sunk into the floor', () => {
    const out = freed({ x: 0.5, y: 63.99, z: 0.5 }, [block(0, 63, 0)])

    expect(out).toBeDefined()
    expect(out!.at.y).toBeCloseTo(64 + CLEARANCE, 6)
    expect(out!.at.x).toBe(0.5)
  })

  /** The one this was written for: shoved into a wall and left there. */
  it('frees a hull knocked into the corner of two blocks', () => {
    const out = freed({ x: 0.29, y: 64, z: 0.29 }, [block(-1, 64, 0), block(0, 64, -1)])

    expect(out).toBeDefined()

    const hull = hullAt(out!.at)
    expect(hull.minX).toBeGreaterThanOrEqual(0)
    expect(hull.minZ).toBeGreaterThanOrEqual(0)
  })

  /** A block placed under an agent lifts it out, the way it lifts a player out. */
  it('lifts an agent out of a block that appeared underneath it', () => {
    const out = freed({ x: 0.5, y: 64.5, z: 0.5 }, [block(0, 64, 0)])

    expect(out).toBeDefined()
    expect(out!.at.y).toBeCloseTo(65 + CLEARANCE, 6)
  })

  /**
   * Buried is a different situation from clipped: a wall built through the agent, a door closed on
   * it. Every way out is a long way, and shoving it that far is a guess about which way it ought to
   * have gone - so the caller is owed the chance to say so rather than having it silently moved.
   */
  it('refuses to move an agent that is buried rather than clipped', () => {
    const solid: Box[] = []
    for (let x = -1; x <= 1; x++) for (let y = 63; y <= 66; y++) for (let z = -1; z <= 1; z++) solid.push(block(x, y, z))

    expect(freed({ x: 0.5, y: 64.5, z: 0.5 }, solid)).toBeUndefined()
  })

  it('never moves further than it is allowed to', () => {
    const out = freed({ x: 0.2, y: 64, z: 0.5 }, [block(-1, 64, 0)])

    if (out) expect(out.by).toBeLessThanOrEqual(MOST)
  })

  it('does not touch the point it was given', () => {
    const at = { x: 0.296, y: 64, z: 0.5 }
    freed(at, [block(-1, 64, 0)])

    expect(at).toEqual({ x: 0.296, y: 64, z: 0.5 })
  })

  /** A partial block is a partial box: a slab underfoot is not a whole one. */
  it('measures against the shape it was handed rather than a whole block', () => {
    const slab: Box = { minX: 0, minY: 63, minZ: 0, maxX: 1, maxY: 63.5, maxZ: 1 }

    // Standing on the slab's top face at 63.5 is flush, not embedded.
    expect(freed({ x: 0.5, y: 63.5, z: 0.5 }, [slab])).toBeUndefined()
    expect(freed({ x: 0.5, y: 63.49, z: 0.5 }, [slab])).toBeDefined()
  })
})

describe('the hull an agent occupies', () => {
  it('is the size the game gives a player, standing on its own position', () => {
    const hull = hullAt({ x: 10, y: 64, z: -5 })

    expect(hull.maxX - hull.minX).toBeCloseTo(HULL_WIDTH, 10)
    expect(hull.maxZ - hull.minZ).toBeCloseTo(HULL_WIDTH, 10)
    expect(hull.maxY - hull.minY).toBeCloseTo(HULL_HEIGHT, 10)
    // Feet on the position, head above it - not centred on it.
    expect(hull.minY).toBe(64)
  })
})

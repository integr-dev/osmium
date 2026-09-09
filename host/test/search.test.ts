import { describe, expect, it } from 'vitest'

import { type Goal, type Neighbours, Search, type Step } from '../src/agent/path/search.ts'

/**
 * A square on a flat open plane, priced the way upstream prices one.
 *
 * The search is told nothing about Minecraft, so a test does not need one: what it needs is squares
 * with a hash and a cost, which is the whole of {@link Step}.
 */
function square(x: number, z: number, cost: number): Step {
  return { x, y: 64, z, hash: `${x},64,${z}`, cost }
}

/** Every neighbour of a square on open ground: eight ways, straight at 1 and diagonal at √2. */
function openGround(blocked: ReadonlySet<string> = new Set()): Neighbours {
  return (from) => {
    const out: Step[] = []

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue

        const x = from.x + dx
        const z = from.z + dz
        if (blocked.has(`${x},${z}`)) continue

        out.push(square(x, z, dx !== 0 && dz !== 0 ? Math.SQRT2 : 1))
      }
    }

    return out
  }
}

/** Upstream's own goal arithmetic: octile distance, which is exactly tight on open ground. */
function goalAt(x: number, z: number): Goal {
  return {
    reached: (at) => at.x === x && at.z === z,
    estimate: (at) => {
      const dx = Math.abs(x - at.x)
      const dz = Math.abs(z - at.z)
      return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2
    },
  }
}

/** Runs a search to the end, however many slices it takes. */
function settle(search: Search) {
  let route = search.run()
  while (route.outcome === 'partial') route = search.run()
  return route
}

/** How many times the route changes direction, which is what the turn cost exists to reduce. */
function turns(steps: readonly Step[], from: Step): number {
  let count = 0
  let dx = 0
  let dz = 0
  let last = from

  for (const step of steps) {
    const nx = Math.sign(step.x - last.x)
    const nz = Math.sign(step.z - last.z)
    if ((dx !== 0 || dz !== 0) && (nx !== dx || nz !== dz)) count++
    dx = nx
    dz = nz
    last = step
  }

  return count
}

describe('Search', () => {
  it('walks a straight line without wandering off it', () => {
    const start = square(0, 0, 0)
    const route = settle(new Search(start, openGround(), goalAt(6, 0)))

    expect(route.outcome).toBe('found')
    expect(route.steps).toHaveLength(6)
    expect(route.steps.map((step) => `${step.x},${step.z}`)).toEqual([
      '1,0',
      '2,0',
      '3,0',
      '4,0',
      '5,0',
      '6,0',
    ])
  })

  it('takes one long straight and one diagonal rather than a staircase', () => {
    const start = square(0, 0, 0)
    const route = settle(new Search(start, openGround(), goalAt(8, 3)))

    expect(route.outcome).toBe('found')
    // Three diagonals and five straights, in whichever order - but only the one change of direction.
    expect(route.steps).toHaveLength(8)
    expect(turns(route.steps, start)).toBe(1)
  })

  it('goes round something in the way', () => {
    const wall = new Set(['3,-1', '3,0', '3,1'])
    const start = square(0, 0, 0)
    const route = settle(new Search(start, openGround(wall), goalAt(6, 0)))

    expect(route.outcome).toBe('found')
    expect(route.steps.some((step) => wall.has(`${step.x},${step.z}`))).toBe(false)
    expect(route.steps[route.steps.length - 1]).toMatchObject({ x: 6, z: 0 })
  })

  it('says so when there is nowhere to go, rather than offering a guess', () => {
    const boxedIn: Neighbours = () => []
    const route = settle(new Search(square(0, 0, 0), boxedIn, goalAt(6, 0)))

    expect(route.outcome).toBe('nowhere')
    expect(route.steps).toEqual([])
  })

  it('answers an unfinished search as unfinished', () => {
    // A slice of no time at all: the first call cannot get anywhere, and has to say as much.
    const search = new Search(square(0, 0, 0), openGround(), goalAt(400, 400), { slice: 0 })

    expect(search.run().outcome).toBe('partial')
  })

  it('gives up even when every slice it is given fills up', () => {
    // **The order of the two clocks.** A search that fills its slice answers `partial`, and a caller
    // answers a partial by running another slice - so if the slice is tested first, the budget is
    // never reached for exactly the searches it exists to stop. That is an agent standing still for
    // ever with a core at a hundred percent, saying nothing.
    const slow = (from: Step): Step[] => {
      const until = Date.now() + 5
      while (Date.now() < until) {
        // Deliberately burning the slice, the way a real neighbour source does on hard ground.
      }
      return openGround()(from) as Step[]
    }

    const search = new Search(square(0, 0, 0), slow, goalAt(9_000, 9_000), { budget: 20, slice: 4 })

    let route = search.run()
    for (let go = 0; go < 50 && route.outcome === 'partial'; go++) route = search.run()

    expect(route.outcome).toBe('timeout')
  })

  it('gives up rather than thinking for ever', () => {
    const search = new Search(square(0, 0, 0), openGround(), goalAt(9_000, 9_000), {
      budget: 0,
      slice: 50,
    })

    expect(search.run().outcome).toBe('timeout')
  })

  it('bounds the detour it will accept, not the distance it will go', () => {
    // A fence across the way with its gap a long way off. Going round is the only route, and it
    // costs far more than heading straight at a goal six blocks away ever should.
    const fence = new Set(Array.from({ length: 13 }, (_unused, i) => `3,${i - 6}`))
    const start = square(0, 0, 0)

    // Unbounded, the detour is worth taking.
    expect(settle(new Search(start, openGround(fence), goalAt(6, 0))).outcome).toBe('found')

    // Held to two blocks over the straight-line estimate, it is not.
    const held = settle(new Search(start, openGround(fence), goalAt(6, 0), { reach: 2 }))
    expect(held.outcome).toBe('nowhere')

    // The bound is on how far past the estimate a route may cost, so a long straight run is still
    // found under the same allowance.
    expect(settle(new Search(start, openGround(), goalAt(60, 0), { reach: 2 })).outcome).toBe('found')
  })

  it('expands far fewer squares than an untied search would', () => {
    // A tight heuristic leaves a plateau of equally good squares. Breaking the tie on the estimate
    // walks it end-first instead of spreading sideways across it: an untied A* visits the whole
    // rectangle between start and goal, which here is well over a hundred squares.
    const route = settle(new Search(square(0, 0, 0), openGround(), goalAt(10, 10)))

    expect(route.outcome).toBe('found')
    expect(route.looked).toBeLessThan(30)
  })

  it('prices a step the way the neighbour source did, turns aside', () => {
    const start = square(0, 0, 0)
    const route = settle(new Search(start, openGround(), goalAt(4, 0)))

    expect(route.cost).toBeCloseTo(4, 6)
  })
})

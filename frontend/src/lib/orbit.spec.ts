import { describe, expect, it } from 'vitest'

import {
  ARRIVED,
  CLOSEST,
  LEAST,
  MOST,
  HURRY,
  FLIGHT,
  MOST_AT_ONCE,
  STRIDE,
  dollyToward,
  easeZoom,
  panRate,
  reachFor,
  wheelTurn,
  zoomFactor,
  type Point,
} from './orbit'

function apart(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

describe('reachFor', () => {
  it('measures what is being looked at against what is being orbited', () => {
    expect(reachFor(50, 10)).toBe(5)
  })

  it('leaves a view of something nearer than the pivot alone', () => {
    // A wall a block in front of a camera orbiting something ten blocks away. Speeding the drag up
    // here would be wrong twice over: the wall crosses the screen as it is.
    expect(reachFor(1, 10)).toBe(LEAST)
  })

  it('does not clamp an ordinary look at the ground from beside an agent', () => {
    // The case the whole thing is for, and the case the first version of it clamped: pivot on an
    // agent five blocks away, ground eighty blocks behind.
    expect(reachFor(80, 5)).toBe(16)
  })

  it('caps a camera sitting on top of what it orbits', () => {
    // Dividing by a pivot distance of a hundredth of a block gives a number with no meaning.
    expect(reachFor(50, 0.01)).toBe(MOST)
  })

  it('changes nothing when there is nothing to measure', () => {
    // Pointed at the sky, so the ray hit nothing. Upstream's own behaviour is the answer that
    // cannot surprise anybody.
    expect(reachFor(undefined, 10)).toBe(LEAST)
    expect(reachFor(50, 0)).toBe(LEAST)
    expect(reachFor(Number.NaN, 10)).toBe(LEAST)
  })
})

describe('panRate', () => {
  /**
   * The whole complaint, as arithmetic.
   *
   * Upstream moves the world by an amount proportional to the pivot distance. With the pivot on an
   * agent and the ground a long way behind it, zooming in shrinks the step while what is on screen
   * stays where it is - so the same drag does less and less.
   */
  it('keeps a drag worth the same at every zoom', () => {
    const ground = 80

    // Pivot on the agent, camera pulled back, and then right in on it.
    const out = panRate(1, ground, 40)
    const close = panRate(1, ground, 5)

    // What matters is the step, which upstream scales by the pivot distance.
    expect(out * 40).toBeCloseTo(close * 5, 5)
  })

  it('is the base rate when there is nothing under the cursor', () => {
    expect(panRate(1.6, undefined, 12)).toBe(1.6)
  })
})

describe('wheelTurn', () => {
  it('reads an ordinary turn off the vertical axis', () => {
    expect(wheelTurn(-100, 0, false)).toBe(-100)
    expect(wheelTurn(100, 0, false)).toBe(100)
  })

  it('finds a hurried turn on the axis the browser moved it to', () => {
    // Shift and a wheel is a request to scroll sideways, so on Windows and Linux the notch arrives
    // as deltaX with a deltaY of zero - and a zoom reading only deltaY does nothing at all for the
    // one gesture that is asking it to hurry.
    expect(wheelTurn(0, -100, true)).toBe(-100 * HURRY)
  })

  it('hurries a turn that stayed on the vertical axis too', () => {
    // macOS leaves it on deltaY, so both have to work.
    expect(wheelTurn(-100, 0, true)).toBe(-100 * HURRY)
  })

  it('travels exactly HURRY times as far for the same turn', () => {
    // The point of multiplying the turn rather than switching to another rate: zoomFactor is
    // exponential in it and dollyToward is linear in its log, so the two compose into a clean
    // multiple of the distance.
    const pivot: Point = { x: 0, y: 0, z: 0 }
    const from: Point = { x: 0, y: 0, z: 40 }

    const walked = dollyToward(from, pivot, zoomFactor(wheelTurn(-100, 0, false)), true)
    const hurried = dollyToward(from, pivot, zoomFactor(wheelTurn(-100, 0, true)), true)

    expect(40 - hurried.camera.z).toBeCloseTo((40 - walked.camera.z) * HURRY, 8)
  })

  it('says nothing happened when nothing did', () => {
    expect(wheelTurn(0, 0, false)).toBe(0)
    expect(wheelTurn(Number.NaN, Number.NaN, false)).toBe(0)
  })
})

describe('zoomFactor', () => {
  it('goes away from a wheel turned down and towards one turned up', () => {
    expect(zoomFactor(100)).toBeGreaterThan(1)
    expect(zoomFactor(-100)).toBeLessThan(1)
    expect(zoomFactor(0)).toBe(1)
  })

  /** What makes a trackpad feel continuous: any two events land where the one that spans them does. */
  it('composes, so two small turns are one big one', () => {
    expect(zoomFactor(30) * zoomFactor(70)).toBeCloseTo(zoomFactor(100), 10)
  })

  it('survives a trackpad fling and a browser measuring in pages', () => {
    expect(zoomFactor(100_000)).toBe(MOST_AT_ONCE)
    expect(zoomFactor(-100_000)).toBe(1 / MOST_AT_ONCE)
    expect(zoomFactor(Number.NaN)).toBe(1)
  })
})

describe('dollyToward', () => {
  const pivot: Point = { x: 0, y: 0, z: 0 }

  /** What one turn of the wheel is worth, in blocks, for each of the two moves. */
  function step(factor: number): number {
    return STRIDE * -Math.log(factor)
  }

  function flown(factor: number): number {
    return FLIGHT * -Math.log(factor)
  }

  it('is worth the same wherever the wheel is turned', () => {
    // The whole complaint, four times over: every version of this was a share of some distance,
    // and each of them shrank to nothing exactly where it was wanted, because the step is closing
    // the very distance it is measured against.
    const near = dollyToward({ x: 0, y: 0, z: 20 }, pivot, 0.9)
    const far = dollyToward({ x: 0, y: 0, z: 400 }, pivot, 0.9)

    expect(20 - near.camera.z).toBeCloseTo(step(0.9), 10)
    expect(400 - far.camera.z).toBeCloseTo(step(0.9), 10)
  })

  it('carries on at that rate however long it is held', () => {
    // It does not fade. Ten notches move ten notches worth, which is what a wheel with the same
    // weight in the hand at the end of a gesture as at the start does.
    let camera: Point = { x: 0, y: 0, z: 20 }
    let target: Point = { x: 0, y: 0, z: 0 }

    for (let turn = 0; turn < 10; turn++) {
      ;({ camera, target } = dollyToward(camera, target, 0.9, true))
    }

    expect(20 - camera.z).toBeCloseTo(10 * flown(0.9), 8)
  })

  it('leaves the pivot where it was put unless it is asked to fly', () => {
    // Moving the point a view turns around is the stronger thing and the one worth asking for:
    // put back by hand it is a worse job than any zoom is worth. So the plain wheel slides the
    // camera along the line of sight and the pivot stays exactly where it is.
    const orbiting = dollyToward({ x: 0, y: 0, z: 20 }, pivot, 0.9)

    expect(orbiting.target).toEqual(pivot)
    expect(20 - orbiting.camera.z).toBeCloseTo(step(0.9), 10)
  })

  it('takes the pivot with it when it is', () => {
    // The gimbal moves into the world with the camera, which is what makes orbiting afterwards
    // turn about something in front of the camera rather than somewhere it has long since left.
    const moved = dollyToward({ x: 0, y: 0, z: 20 }, pivot, 0.9, true)

    expect(moved.target.z).toBeCloseTo(-flown(0.9), 10)
    expect(apart(moved.camera, moved.target)).toBeCloseTo(20, 10)
  })

  it('slides the camera up to the pivot and no further', () => {
    // Sliding closes the gap, so without a floor the camera arrives at the thing it is turning
    // around and then passes through it.
    let camera: Point = { x: 0, y: 0, z: 20 }

    for (let turn = 0; turn < 200; turn++) {
      ;({ camera } = dollyToward(camera, pivot, 0.9))
    }

    expect(apart(camera, pivot)).toBeCloseTo(CLOSEST, 10)
  })

  it('flies back out the way it flew in', () => {
    // The one-way version pushed the pivot off into the world and left no way of getting it home:
    // winding the wheel back opened a gap instead of retracing the flight, so a view that had been
    // flown somewhere had to be rebuilt by hand. A translation has an exact inverse.
    let camera: Point = { x: 0, y: 0, z: 20 }
    let target: Point = { x: 0, y: 0, z: 0 }

    for (let turn = 0; turn < 12; turn++) {
      ;({ camera, target } = dollyToward(camera, target, 0.9, true))
    }

    expect(20 - camera.z).toBeCloseTo(12 * flown(0.9), 8)

    for (let turn = 0; turn < 12; turn++) {
      ;({ camera, target } = dollyToward(camera, target, 1 / 0.9, true))
    }

    expect(camera.z).toBeCloseTo(20, 8)
    expect(target.z).toBeCloseTo(0, 8)
  })


  it('leaves a camera standing on its own pivot alone', () => {
    // No line of sight to fly along.
    const camera: Point = { x: 0, y: 0, z: 0 }
    const same = dollyToward(camera, pivot, 0.5)

    expect(same.camera).toEqual(camera)
  })
})

describe('easeZoom', () => {
  it('spends a share of what is owed and keeps the rest', () => {
    const { step, left } = easeZoom(0.5, 0.2)

    // A fifth of the way there in the log, which is the shape zooming has.
    expect(step).toBeCloseTo(Math.pow(0.5, 0.2), 10)
    expect(step * left).toBeCloseTo(0.5, 10)
  })

  /** Frame after frame lands exactly where the one jump would have, which is why it is eased in log. */
  it('arrives at the zoom it was asked for', () => {
    let left = 0.25
    let spent = 1

    for (let frame = 0; frame < 200 && left !== 1; frame++) {
      const step = easeZoom(left)
      spent *= step.step
      left = step.left
    }

    expect(left).toBe(1)
    expect(spent).toBeCloseTo(0.25, 6)
  })

  it('stops rather than creeping for ever', () => {
    // Geometric easing never actually reaches, so there has to be a point it is called arrived at.
    expect(easeZoom(1).left).toBe(1)
    expect(easeZoom(1 + ARRIVED / 2).left).toBe(1)
  })

  it('gives back nothing to do when there is nothing to do', () => {
    expect(easeZoom(0)).toEqual({ step: 1, left: 1 })
    expect(easeZoom(Number.NaN)).toEqual({ step: 1, left: 1 })
  })

  /** A notch arriving mid-glide multiplies into it, so the two finish together. */
  it('lets a second notch join the first', () => {
    const half = easeZoom(0.5)
    const joined = half.left * 0.5

    let left = joined
    let spent = half.step

    for (let frame = 0; frame < 200 && left !== 1; frame++) {
      const step = easeZoom(left)
      spent *= step.step
      left = step.left
    }

    expect(spent).toBeCloseTo(0.25, 6)
  })
})

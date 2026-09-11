import { describe, expect, it } from 'vitest'

import {
  ARRIVED,
  CLOSEST,
  LEAST,
  MOST,
  MOST_AT_ONCE,
  dollyToward,
  easeZoom,
  panRate,
  reachFor,
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
  const at: Point = { x: 0, y: 0, z: 0 }

  it('holds the point under the cursor still', () => {
    const camera = { x: 0, y: 10, z: 20 }
    const target = { x: 0, y: 2, z: 4 }

    const closer = dollyToward(camera, target, at, 0.5)

    // Camera, pivot and the point stay on one line, and the point does not move: everything else
    // is half as far from it as it was, which is what keeps it under the cursor.
    expect(apart(closer.camera, at)).toBeCloseTo(apart(camera, at) / 2, 10)
    expect(apart(closer.target, at)).toBeCloseTo(apart(target, at) / 2, 10)
  })

  it('does not turn the camera, only move it', () => {
    const camera = { x: 3, y: 10, z: 20 }
    const target = { x: 1, y: 2, z: 4 }

    const before = apart(camera, target)
    const closer = dollyToward(camera, target, at, 0.5)

    // Both scale about the same point, so the camera still looks along the same line - the whole
    // arrangement is just smaller.
    expect(apart(closer.camera, closer.target)).toBeCloseTo(before / 2, 10)
  })

  /** A share of the remaining distance, so arriving costs less and less. */
  it('slows down as it approaches a surface', () => {
    const first = dollyToward({ x: 0, y: 0, z: 40 }, { x: 0, y: 0, z: 30 }, at, 0.8)
    const second = dollyToward(first.camera, first.target, at, 0.8)

    const one = 40 - apart(first.camera, at)
    const two = apart(first.camera, at) - apart(second.camera, at)

    expect(two).toBeLessThan(one)
  })

  it('will not put the camera inside what it is aimed at', () => {
    let camera: Point = { x: 0, y: 0, z: 10 }
    let target: Point = { x: 0, y: 0, z: 5 }

    for (let turn = 0; turn < 200; turn++) {
      ;({ camera, target } = dollyToward(camera, target, at, 0.5))
    }

    expect(apart(camera, at)).toBeCloseTo(CLOSEST, 5)
  })

  it('still lets go of a wall it has been pushed against', () => {
    const camera = { x: 0, y: 0, z: CLOSEST }
    const out = dollyToward(camera, { x: 0, y: 0, z: 0.1 }, at, 2)

    expect(apart(out.camera, at)).toBeCloseTo(CLOSEST * 2, 10)
  })

  it('leaves a camera standing on the point it is aimed at alone', () => {
    const camera = { x: 0, y: 0, z: 0 }
    const same = dollyToward(camera, { x: 0, y: 0, z: 5 }, at, 0.5)

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

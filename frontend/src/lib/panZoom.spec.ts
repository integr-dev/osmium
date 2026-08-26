import { describe, expect, it } from 'vitest'
import { clampScale, fit, IDENTITY, MAX_SCALE, MIN_SCALE, panBy, zoomAt } from './panZoom'

/** Where a point of the picture has ended up on screen, under a given view. */
function project(view: { x: number; y: number; k: number }, at: number): number {
  return view.x + at * view.k
}

describe('zooming', () => {
  it('leaves whatever is under the pointer under the pointer', () => {
    const view = { x: 30, y: -10, k: 1 }
    // The picture point currently sitting at 200px across.
    const under = (200 - view.x) / view.k

    const zoomed = zoomAt(view, 200, 120, 1.5)

    expect(project(zoomed, under)).toBeCloseTo(200)
    expect(zoomed.k).toBe(1.5)
  })

  it('holds the point still when zooming out as well', () => {
    const view = { x: -80, y: 40, k: 2 }
    const under = (150 - view.x) / view.k

    expect(project(zoomAt(view, 150, 0, 0.5), under)).toBeCloseTo(150)
  })

  /** A wheel turn at either end should do nothing, rather than slide a picture it will not resize. */
  it('does not move the picture once it has stopped scaling', () => {
    const zoomedIn = zoomAt({ x: 12, y: 8, k: MAX_SCALE }, 100, 100, 2)
    expect(zoomedIn).toEqual({ x: 12, y: 8, k: MAX_SCALE })

    const zoomedOut = zoomAt({ x: 12, y: 8, k: MIN_SCALE }, 100, 100, 0.5)
    expect(zoomedOut).toEqual({ x: 12, y: 8, k: MIN_SCALE })
  })

  it('clamps', () => {
    expect(clampScale(100)).toBe(MAX_SCALE)
    expect(clampScale(0)).toBe(MIN_SCALE)
    expect(clampScale(1.25)).toBe(1.25)
  })
})

describe('panning', () => {
  it('moves by the pointer, at whatever scale', () => {
    expect(panBy({ x: 10, y: 20, k: 2 }, 5, -5)).toEqual({ x: 15, y: 15, k: 2 })
  })
})

describe('fitting', () => {
  it('centres a picture that already fits, at its own size', () => {
    expect(fit(200, 100, 400, 300)).toEqual({ k: 1, x: 100, y: 100 })
  })

  it('shrinks one that does not, by whichever axis runs out first', () => {
    const view = fit(800, 200, 400, 300)

    expect(view.k).toBe(0.5)
    expect(view.x).toBe(0)
    expect(view.y).toBe(100)
  })

  it('has nothing to fit before the picture has a size', () => {
    expect(fit(0, 0, 400, 300)).toBe(IDENTITY)
  })
})

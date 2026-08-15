import { describe, expect, it } from 'vitest'
import { clampPitch, clampZoom, MAX_PITCH, MAX_ZOOM, MIN_ZOOM, project, type Box } from './box3d'

/**
 * The renderer is a few `<polygon>` tags; all of the ways it can be wrong are here. Every one of
 * them draws something — a box inside out, a box off the edge of its viewport, a split whose
 * segments are all the same size — so none of them fails as an error.
 */
const VIEW = { yaw: 0.6, pitch: 0.5, width: 400, height: 300 }

const cube: Box = { id: 'cube', min: { x: 0, y: 0, z: 0 }, max: { x: 16, y: 16, z: 16 } }

describe('project', () => {
  it('shows at most three faces of a box, from any angle', () => {
    // A box has six faces and three of them are always turned away. Drawing the hidden ones is the
    // classic mistake: it still renders, as a box that reads inside out.
    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.2) {
      for (const pitch of [-1.2, -0.4, 0, 0.4, 1.2]) {
        const [box] = project([cube], { ...VIEW, yaw, pitch }).boxes

        expect(box.faces.length).toBeGreaterThan(0)
        expect(box.faces.length).toBeLessThanOrEqual(3)
      }
    }
  })

  it('keeps every corner inside the viewport', () => {
    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.3) {
      const scene = project([cube], { ...VIEW, yaw })

      scene.boxes.flatMap((box) => box.corners).forEach(({ at }) => {
        expect(at.x).toBeGreaterThanOrEqual(0)
        expect(at.x).toBeLessThanOrEqual(scene.width)
        expect(at.y).toBeGreaterThanOrEqual(0)
        expect(at.y).toBeLessThanOrEqual(scene.height)
      })
    }
  })

  it('scales several boxes together, not each to itself', () => {
    // A split preview is boxes that have to stay in proportion. Fitted individually, the smallest
    // segment draws the same size as the largest and the picture says the opposite of the truth.
    const scene = project(
      [
        { id: 'small', min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
        { id: 'large', min: { x: 10, y: 0, z: 0 }, max: { x: 50, y: 10, z: 10 } },
      ],
      VIEW,
    )

    const width = (id: string) => {
      const xs = scene.boxes.find((box) => box.id === id)!.corners.map((corner) => corner.at.x)
      return Math.max(...xs) - Math.min(...xs)
    }

    expect(width('large')).toBeGreaterThan(width('small') * 2)
  })

  it('draws the furthest box first', () => {
    const scene = project(
      [
        { id: 'near', min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } },
        { id: 'far', min: { x: 0, y: 0, z: 40 }, max: { x: 4, y: 4, z: 44 } },
      ],
      { ...VIEW, yaw: 0, pitch: 0 },
    )

    // Painter's order, which is exact here: the segments of a split never overlap, so there is
    // never a pair that has to be split to be drawn correctly.
    expect(scene.boxes.map((box) => box.id)).toEqual(['far', 'near'])
  })

  it('reports measurements in blocks, whatever the rotation', () => {
    // The one number on screen that is not a picture. It comes from the box, not from the
    // projection, so turning the view must not change it.
    const box: Box = { id: 'hall', min: { x: -8, y: 60, z: 4 }, max: { x: 24, y: 68, z: 20 } }

    for (const yaw of [0, 1, 2.5, 4]) {
      const [projected] = project([box], { ...VIEW, yaw }).boxes

      expect(projected.dimensions.map((d) => [d.axis, d.length])).toEqual([
        ['x', 32],
        ['y', 8],
        ['z', 16],
      ])
    }
  })

  it('labels each corner with the coordinate it actually is', () => {
    const box: Box = { id: 'hall', min: { x: -8, y: 60, z: 4 }, max: { x: 24, y: 68, z: 20 } }

    const [projected] = project([box], VIEW).boxes
    const worlds = projected.corners.map((corner) => corner.world)

    expect(projected.corners).toHaveLength(8)
    expect(worlds).toContainEqual({ x: -8, y: 60, z: 4 })
    expect(worlds).toContainEqual({ x: 24, y: 68, z: 20 })
    // Eight distinct corners: a repeat means two flags were read from the same axis.
    expect(new Set(worlds.map((world) => JSON.stringify(world))).size).toBe(8)
  })

  it('comes back to the same picture after a full turn', () => {
    const once = project([cube], { ...VIEW, yaw: 0.4 })
    const again = project([cube], { ...VIEW, yaw: 0.4 + Math.PI * 2 })

    expect(again.boxes[0].corners.map((corner) => corner.at)).toEqual(
      once.boxes[0].corners.map((corner) => corner.at),
    )
  })

  it('survives a schematic with no thickness', () => {
    // A single layer, or a one-block column. Its extent on an axis is zero, and dividing by it
    // would put every corner at infinity — which renders as nothing at all.
    const flat: Box = { id: 'floor', min: { x: 0, y: 64, z: 0 }, max: { x: 32, y: 64, z: 32 } }

    const [projected] = project([flat], { ...VIEW, pitch: 0, yaw: 0 }).boxes

    projected.corners.forEach(({ at }) => {
      expect(Number.isFinite(at.x)).toBe(true)
      expect(Number.isFinite(at.y)).toBe(true)
    })
  })

  it('shades the faces differently so the box reads as solid', () => {
    const [projected] = project([cube], VIEW).boxes
    const shades = projected.faces.map((face) => face.shade)

    expect(new Set(shades).size).toBe(shades.length)
    shades.forEach((shade) => {
      expect(shade).toBeGreaterThan(0)
      expect(shade).toBeLessThanOrEqual(1)
    })
  })

  it('grows the picture without moving what it is centred on', () => {
    const at = (zoom: number) =>
      project([cube], { ...VIEW, zoom }).boxes[0].corners.map((corner) => corner.at)

    const fitted = at(1)
    const closer = at(2)

    const span = (points: typeof fitted) =>
      Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x))
    const middle = (points: typeof fitted) =>
      (Math.max(...points.map((p) => p.x)) + Math.min(...points.map((p) => p.x))) / 2

    // Twice the size, same centre. A zoom that shifted the picture would send the operator hunting
    // for the thing they were already looking at.
    expect(span(closer)).toBeCloseTo(span(fitted) * 2, 0)
    expect(middle(closer)).toBeCloseTo(middle(fitted), 0)
  })

  it('bounds how far in and out it goes', () => {
    // Far enough out and the box is a dot; far enough in and it is one face filling the frame.
    // Neither is a view of anything.
    expect(clampZoom(100)).toBe(MAX_ZOOM)
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(2)).toBe(2)
  })

  it('stops short of looking straight down the axis', () => {
    // At exactly vertical a box collapses to a rectangle and every face but one disappears, so a
    // drag that reached it would look like the picture had broken.
    expect(clampPitch(3)).toBe(MAX_PITCH)
    expect(clampPitch(-3)).toBe(-MAX_PITCH)
    expect(clampPitch(0.5)).toBe(0.5)
  })
})

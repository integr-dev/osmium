import { describe, expect, it } from 'vitest'
import { rotation } from './box3d'
import { drawOrder, FACE_NORMALS, FACE_SHADES, visibleFaces } from './voxels'

/**
 * The two decisions that make a voxel preview affordable. Both fail as a picture rather than as an
 * error: the wrong order draws far cubes over near ones, and the wrong faces draw the inside of the
 * model over its outside.
 */
describe('drawOrder', () => {
  it('walks each axis away from the viewer', () => {
    // Straight on: +Z points at the camera, so Z is walked from the back forward and the near face
    // of the model is painted last.
    const order = drawOrder(rotation(0, 0))

    expect(order.z).toBe(-1)
  })

  it('flips an axis when the model is turned past it', () => {
    // Half a turn puts the far side near. An order fixed at build time would then paint the back of
    // the building over its front — which renders, and looks like the model is inside out.
    //
    // Turned off-axis first: at yaw 0 the X axis lies exactly across the view, its depth is zero,
    // and which way it is walked genuinely does not matter — so comparing it there would be
    // asserting on a rounding error.
    const front = drawOrder(rotation(0.7, 0))
    const behind = drawOrder(rotation(0.7 + Math.PI, 0))

    expect(behind.z).toBe(-front.z)
    expect(behind.x).toBe(-front.x)
  })

  it('decides all three axes independently', () => {
    // A view from above and to one side flips a different pair than a view from below.
    const above = drawOrder(rotation(0.7, 0.9))
    const below = drawOrder(rotation(0.7, -0.9))

    expect(above.y).toBe(-below.y)
    expect(above.x).toBe(below.x)
  })
})

describe('visibleFaces', () => {
  it('never keeps more than three faces of a cube', () => {
    // Three of six always point away, whatever the angle. Drawing them costs twice the work and
    // paints the inside of the model over the outside.
    const exposed = 0b111111

    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.2) {
      for (const pitch of [-1.2, -0.4, 0, 0.4, 1.2]) {
        const mask = visibleFaces(exposed, rotation(yaw, pitch))
        const kept = FACE_NORMALS.filter((_, bit) => mask & (1 << bit)).length

        expect(kept).toBeGreaterThan(0)
        expect(kept).toBeLessThanOrEqual(3)
      }
    }
  })

  it('never draws a face the backend said has a neighbour', () => {
    // The enclosure pass is what removes most of the work. Ignoring its mask here would put it all
    // back, and would draw faces buried inside the solid.
    const onlyUp = 0b001000

    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.3) {
      const mask = visibleFaces(onlyUp, rotation(yaw, 0.5))
      expect(mask & ~onlyUp).toBe(0)
    }
  })

  it('keeps nothing for a cube with every side covered', () => {
    expect(visibleFaces(0, rotation(0.6, 0.4))).toBe(0)
  })
})

describe('FACE_SHADES', () => {
  it('gives every face a legible brightness', () => {
    expect(FACE_SHADES).toHaveLength(6)
    FACE_SHADES.forEach((shade) => {
      // The floor is ambient light. Without it an unlit face is black, and a black face against a
      // dark background is a hole in the model.
      expect(shade).toBeGreaterThanOrEqual(0.4)
      expect(shade).toBeLessThanOrEqual(1)
    })
  })

  it('makes the top the brightest face and the underside the darkest', () => {
    // The whole reason the light is fixed to the world rather than to the camera. Fixed to the
    // camera, the top is bright from one angle and dark from another, and nothing in the picture
    // says which way is up — which is exactly how an operator ends up looking at a building from
    // underneath without noticing.
    const top = FACE_SHADES[3]!
    const bottom = FACE_SHADES[2]!

    expect(top).toBe(Math.max(...FACE_SHADES))
    expect(bottom).toBe(Math.min(...FACE_SHADES))
  })

  it('separates the four sides from each other', () => {
    // A straight-down light leaves all four sides identical and the model reads as a cross rather
    // than as a solid, so the light is tilted off vertical.
    const sides = [FACE_SHADES[0]!, FACE_SHADES[1]!, FACE_SHADES[4]!, FACE_SHADES[5]!]

    expect(new Set(sides.map((shade) => shade.toFixed(3))).size).toBeGreaterThan(1)
  })
})

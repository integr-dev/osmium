import { describe, expect, it } from 'vitest'
import { LEGACY_COPIES } from './skins'

/**
 * The legacy skin conversion, checked as a table.
 *
 * The canvas work around it is five lines; the table is where this goes wrong, and it goes wrong
 * quietly — a rectangle a few pixels out copies part of the torso onto an arm, which renders as a
 * player with a smear on one sleeve and nothing that says why. jsdom has no canvas, so what is
 * pinned is the arithmetic rather than the pixels.
 *
 * The layouts, for reading the numbers against:
 *
 * - A legacy sheet is 64x32 and has one arm at `(40,16)` and one leg at `(0,16)`, each a 16x16 block
 *   of six faces.
 * - The modern sheet adds the other arm at `(32,48)` and the other leg at `(16,48)`, in the bottom
 *   half that a legacy skin does not have at all.
 */
describe('the legacy skin conversion', () => {
  it('copies all six faces of both limbs', () => {
    // Twelve, not two: the block is copied face by face because each one is mirrored into a
    // different place, and a block copied whole would have the front and back swapped.
    expect(LEGACY_COPIES).toHaveLength(12)
  })

  it('reads only from the half a legacy skin actually has', () => {
    for (const { from } of LEGACY_COPIES) {
      const [x, y, width, height] = from
      expect(x, `${from}`).toBeGreaterThanOrEqual(0)
      expect(y, `${from}`).toBeGreaterThanOrEqual(0)
      expect(x + width, `${from}`).toBeLessThanOrEqual(64)
      // 32 is the whole of a legacy sheet. Reading past it is reading the transparency that is the
      // reason this conversion exists.
      expect(y + height, `${from}`).toBeLessThanOrEqual(32)
    }
  })

  it('writes only into the half the model would otherwise sample as empty', () => {
    for (const { from, to } of LEGACY_COPIES) {
      const [, , width, height] = from
      const [x, y] = to
      expect(x, `${to}`).toBeGreaterThanOrEqual(0)
      expect(x + width, `${to}`).toBeLessThanOrEqual(64)
      // The bottom half only: everything above 48 is what was copied over wholesale, and writing
      // there would paint over the limbs the skin does have.
      expect(y, `${to}`).toBeGreaterThanOrEqual(48)
      expect(y + height, `${to}`).toBeLessThanOrEqual(64)
    }
  })

  it('lands in the two blocks the modern layout adds', () => {
    // The left leg occupies x 16..32 and the left arm x 32..48. Anything outside those two is
    // landing on the torso overlay or off the sheet.
    for (const { from, to } of LEGACY_COPIES) {
      const [, , width] = from
      const [x] = to
      expect(x, `${to}`).toBeGreaterThanOrEqual(16)
      expect(x + width, `${to}`).toBeLessThanOrEqual(48)
    }
  })

  it('writes every destination exactly once', () => {
    // Two copies landing on one rectangle means one face was named twice and another not at all,
    // which leaves a hole somebody only finds by orbiting a player.
    const written = LEGACY_COPIES.map(({ from, to }) => `${to[0]},${to[1]},${from[2]},${from[3]}`)
    expect(new Set(written).size).toBe(written.length)
  })

  it('covers both limbs evenly', () => {
    const leg = LEGACY_COPIES.filter(({ to }) => to[0] < 32)
    const arm = LEGACY_COPIES.filter(({ to }) => to[0] >= 32)

    expect(leg).toHaveLength(6)
    expect(arm).toHaveLength(6)
  })

  it('keeps each face the size it was', () => {
    // The tops and bottoms are 4x4 and the four sides 4x12. A face that changed size on the way
    // across would be stretched by the copy rather than refused by it.
    for (const { from } of LEGACY_COPIES) {
      const [, , width, height] = from
      expect(width).toBe(4)
      expect([4, 12]).toContain(height)
    }
  })
})

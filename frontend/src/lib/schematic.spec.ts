import { describe, expect, it } from 'vitest'
import { schematicField, type Block } from './schematic'

const OPTIONS = { radius: 160, size: 22, stagger: 10 }

function pointsOf(block: Block): Array<[number, number]> {
  return [block.top, block.left, block.right]
    .flatMap((face) => face.split(' '))
    .map((pair) => pair.split(',').map(Number) as [number, number])
}

/** The centre of the top face, which is the lattice point the block was chosen by. */
function centreOf(block: Block): [number, number] {
  const points = block.top.split(' ').map((pair) => pair.split(',').map(Number))
  return [
    points.reduce((sum, [x]) => sum + x, 0) / points.length,
    points.reduce((sum, [, y]) => sum + y, 0) / points.length,
  ]
}

function distanceOf(block: Block): number {
  const [x, y] = centreOf(block)
  return Math.sqrt(x * x + y * y)
}

describe('schematicField', () => {
  it('leaves gaps without emptying the field', () => {
    const { blocks } = schematicField(OPTIONS)

    // The point of the gaps is that the field reads as partly built. All of them or none of them
    // and it reads as a plate or as nothing.
    expect(blocks.length).toBeGreaterThan(80)
    expect(blocks.length).toBeLessThan(160)
  })

  it('gives the same field for the same options', () => {
    // Which cells are empty is decoration, but decoration that moved on every render would be a
    // flicker rather than a pattern.
    expect(schematicField(OPTIONS)).toEqual(schematicField(OPTIONS))
  })

  /**
   * The reason the field is laid out in projected space. Choosing cells on a square grid and
   * projecting afterwards is the obvious way to write this and produces a 2:1 diamond — which is
   * a perfectly good render of the wrong shape, and nothing else in the output would say so.
   */
  it('fills a circle rather than a diamond', () => {
    const centres = schematicField(OPTIONS).blocks.map(centreOf)

    const wide = Math.max(...centres.map(([x]) => Math.abs(x)))
    const tall = Math.max(...centres.map(([, y]) => Math.abs(y)))

    expect(Math.abs(wide - tall)).toBeLessThan(2 * OPTIONS.size)
    expect(wide).toBeLessThanOrEqual(OPTIONS.radius)
    expect(tall).toBeLessThanOrEqual(OPTIONS.radius)
  })

  it('never lands two blocks on the same spot', () => {
    const { blocks } = schematicField(OPTIONS)

    // Half of an isometric lattice is not a lattice: take every cell of the square grid and the
    // blocks sit at half-steps, interpenetrating rather than tiling.
    const centres = new Set(blocks.map((block) => centreOf(block).join()))
    expect(centres.size).toBe(blocks.length)
  })

  it('draws a top face twice as wide as it is tall', () => {
    const [block] = schematicField(OPTIONS).blocks
    const top = block.top.split(' ').map((pair) => pair.split(',').map(Number))

    expect(top).toHaveLength(4)
    const xs = top.map(([x]) => x)
    const ys = top.map(([, y]) => y)
    // The isometric ratio. Get it wrong and the blocks still render, as cubes seen from an angle
    // nothing else in the field agrees with.
    expect(Math.max(...xs) - Math.min(...xs)).toBe(2 * (Math.max(...ys) - Math.min(...ys)))
  })

  it('joins the two side faces along one edge', () => {
    const [block] = schematicField(OPTIONS).blocks

    const sharedBy = (face: string) => face.split(' ').slice(1, 3).join(' ')

    // The near vertical edge. Drawn from different corners the faces still render, as two panels
    // with a seam of background between them.
    expect(sharedBy(block.left)).toBe(sharedBy(block.right))
  })

  it('fits every block inside the viewBox', () => {
    const field = schematicField(OPTIONS)
    const [x, y, width, height] = field.viewBox.split(' ').map(Number)

    const points = field.blocks.flatMap(pointsOf)

    // A viewBox that misses the field crops it silently, and the crop is invisible in review
    // because the part that is left still looks correct.
    expect(Math.min(...points.map(([px]) => px))).toBeGreaterThanOrEqual(x)
    expect(Math.max(...points.map(([px]) => px))).toBeLessThanOrEqual(x + width)
    expect(Math.min(...points.map(([, py]) => py))).toBeGreaterThanOrEqual(y)
    expect(Math.max(...points.map(([, py]) => py))).toBeLessThanOrEqual(y + height)
  })

  it('places blocks in courses, within the stagger', () => {
    const { blocks } = schematicField(OPTIONS)
    const delays = blocks.map((block) => block.delay)

    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(OPTIONS.stagger)

    // The jitter inside a course is bounded by the gap between courses, so it never reorders two
    // blocks belonging to different ones — without that bound the disc fills in patches instead of
    // sweeping across. A course is a row of constant depth, so placing the blocks in delay order
    // must walk down the field and never back up.
    const depthOf = (block: Block) => Math.min(...pointsOf(block).map(([, y]) => y))
    const depths = [...blocks].sort((a, b) => a.delay - b.delay).map(depthOf)

    expect(depths).toEqual([...depths].sort((a, b) => a - b))
  })

  it('fades from the centre to the rim', () => {
    const byDistance = [...schematicField(OPTIONS).blocks].sort(
      (a, b) => distanceOf(a) - distanceOf(b),
    )
    const fades = byDistance.map((block) => block.fade)

    // The disc has to end rather than stop. A constant opacity gives it a hard edge, which reads
    // as a cropped image rather than as a shape.
    expect(fades[0]).toBeGreaterThan(0.85)
    expect(fades.at(-1)).toBeLessThan(0.45)
    // Dimmer at the rim, not gone: a block that fades to nothing shortens the disc instead of
    // softening it, and the outline stops being round.
    expect(fades.at(-1)).toBeGreaterThan(0.25)
    expect(fades).toEqual([...fades].sort((a, b) => b - a))
  })
})

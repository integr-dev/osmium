import type { BlockPos } from '../protocol/wire.ts'
import { MAGIC } from '../agent/build/segment.ts'
import { build, PITCH, specimens, TARGET, type Specimen } from './specimens.ts'

/**
 * The specimens, laid out as one build.
 *
 * A grid, pedestal by pedestal, with a square of air between each one so that nothing connects to
 * its neighbour: a fence that reaches across the gap changes its own state and the one it reaches,
 * which would be two failing lines caused by the layout rather than by the printer.
 */

export interface Plot {
  /** The specimen's name, which is what a report is grouped by. */
  name: string
  /** The pedestal's own corner in the world. */
  origin: BlockPos
  /** The square the block under test stands in. */
  target: BlockPos
}

export interface Layout {
  min: BlockPos
  size: { x: number; y: number; z: number }
  /** Every block, ascending by the linear index the segment format uses. */
  blocks: { at: BlockPos; state: string }[]
  plots: Plot[]
}

/** How many pedestals to a row. Wide enough to stay compact, short enough to fly along. */
const ACROSS = 12

/** A pedestal is never taller than this, which is what makes the box one height. */
const HEIGHT = 4

export function layout(anchor: BlockPos, across = ACROSS): Layout {
  const all = specimens()
  const rows = Math.ceil(all.length / across)

  const size = {
    x: across * PITCH - 1,
    y: HEIGHT,
    z: rows * PITCH - 1,
  }

  const plots: Plot[] = []
  const placed = new Map<number, string>()

  all.forEach((specimen: Specimen, index: number) => {
    const column = index % across
    const row = Math.floor(index / across)
    const origin = { x: anchor.x + column * PITCH, y: anchor.y, z: anchor.z + row * PITCH }

    plots.push({
      name: specimen.name,
      origin,
      target: { x: origin.x + TARGET.x, y: origin.y + TARGET.y, z: origin.z + TARGET.z },
    })

    for (const block of build(specimen)) {
      const at = { x: origin.x + block.at.x, y: origin.y + block.at.y, z: origin.z + block.at.z }
      placed.set(linear(at, anchor, size), block.state)
    }
  })

  const blocks = [...placed.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, state]) => ({ at: position(index, anchor, size), state }))

  return { min: anchor, size, blocks, plots }
}

/** The order both schematic formats and the segment format store positions in. */
function linear(at: BlockPos, min: BlockPos, size: { x: number; y: number; z: number }): number {
  return ((at.y - min.y) * size.z + (at.z - min.z)) * size.x + (at.x - min.x)
}

function position(index: number, min: BlockPos, size: { x: number; y: number; z: number }): BlockPos {
  const plane = size.x * size.z
  const y = Math.floor(index / plane)
  const rest = index - y * plane
  const z = Math.floor(rest / size.x)

  return { x: min.x + (rest - z * size.x), y: min.y + y, z: min.z + z }
}

/**
 * The layout in the format a host is handed a piece in.
 *
 * Written by the rig rather than by the backend on purpose: it is the same bytes the backend would
 * serve, so the printer under test is fed exactly what it is fed in production — and the rig needs
 * no job, no split and no database to run.
 */
export function pack(view: Layout): Uint8Array {
  const palette: string[] = []
  const indices = new Map<string, number>()

  for (const block of view.blocks) {
    if (indices.has(block.state)) continue
    indices.set(block.state, palette.length)
    palette.push(block.state)
  }

  const names = palette.map((state) => Buffer.from(state, 'utf8'))
  const header = 4 + 2 + names.reduce((sum, name) => sum + 2 + name.length, 0) + 24 + 4
  const out = Buffer.alloc(header + view.blocks.length * 6)

  let at = out.write(MAGIC, 0, 'ascii')
  at = out.writeUInt16BE(palette.length, at)
  for (const name of names) {
    at = out.writeUInt16BE(name.length, at)
    at += name.copy(out, at)
  }

  at = out.writeInt32BE(view.min.x, at)
  at = out.writeInt32BE(view.min.y, at)
  at = out.writeInt32BE(view.min.z, at)
  at = out.writeUInt32BE(view.size.x, at)
  at = out.writeUInt32BE(view.size.y, at)
  at = out.writeUInt32BE(view.size.z, at)
  at = out.writeUInt32BE(view.blocks.length, at)

  for (const block of view.blocks) {
    at = out.writeUInt32BE(linear(block.at, view.min, view.size), at)
    at = out.writeUInt16BE(indices.get(block.state)!, at)
  }

  return new Uint8Array(out)
}

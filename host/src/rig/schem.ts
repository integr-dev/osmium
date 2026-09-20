import { gzipSync } from 'node:zlib'

import type { Layout } from './layout.ts'

/**
 * The layout as a Sponge `.schem`, so it can be run through the real thing.
 *
 * The rig's fast loop never needs this — it packs a segment and hands it straight to the printer.
 * This is for the slow one: uploading the same build to Osmium, planning it, splitting it and
 * watching agents put it down, which is the path that has a backend, a job and an operator in it.
 * One generator for both means the two builds are the same build.
 *
 * Version 2 rather than 3, which is the one both this repository's decoder and every editor in the
 * world read without argument.
 */

/** 1.21.4. The decoders carry it through without interpreting it; a server does not. */
const DATA_VERSION = 4189

const AIR = 'minecraft:air'

export function schematic(view: Layout): Buffer {
  const palette: string[] = [AIR]
  const indices = new Map<string, number>([[AIR, 0]])

  for (const block of view.blocks) {
    if (indices.has(block.state)) continue
    indices.set(block.state, palette.length)
    palette.push(block.state)
  }

  // A dense grid, which is what this format is: one varint per position of the box, air included.
  const positions = view.size.x * view.size.y * view.size.z
  const grid = new Uint16Array(positions)
  for (const block of view.blocks) {
    const index =
      ((block.at.y - view.min.y) * view.size.z + (block.at.z - view.min.z)) * view.size.x +
      (block.at.x - view.min.x)
    grid[index] = indices.get(block.state)!
  }

  const data: number[] = []
  for (const state of grid) varint(data, state)

  const body = Buffer.concat([
    int('Version', 2),
    int('DataVersion', DATA_VERSION),
    short('Width', view.size.x),
    short('Height', view.size.y),
    short('Length', view.size.z),
    intArray('Offset', [view.min.x, view.min.y, view.min.z]),
    int('PaletteMax', palette.length),
    compound('Palette', Buffer.concat(palette.map((state, at) => int(state, at)))),
    byteArray('BlockData', Buffer.from(data)),
    // What editors read to put a paste back where it came from. Written because they expect it,
    // and ignored by everything in this repository.
    compound(
      'Metadata',
      Buffer.concat([int('WEOffsetX', 0), int('WEOffsetY', 0), int('WEOffsetZ', 0)]),
    ),
  ])

  return gzipSync(compound('Schematic', body))
}

// ---------------------------------------------------------------- NBT, by hand

const BYTE_ARRAY = 7
const COMPOUND = 10
const INT_ARRAY = 11

function name(tag: number, label: string): Buffer {
  const text = Buffer.from(label, 'utf8')
  const head = Buffer.alloc(3)
  head.writeUInt8(tag, 0)
  head.writeUInt16BE(text.length, 1)

  return Buffer.concat([head, text])
}

function short(label: string, value: number): Buffer {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(value & 0xffff)
  return Buffer.concat([name(2, label), body])
}

function int(label: string, value: number): Buffer {
  const body = Buffer.alloc(4)
  body.writeInt32BE(value)
  return Buffer.concat([name(3, label), body])
}

function byteArray(label: string, bytes: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeInt32BE(bytes.length)
  return Buffer.concat([name(BYTE_ARRAY, label), length, bytes])
}

function intArray(label: string, values: readonly number[]): Buffer {
  const body = Buffer.alloc(4 + values.length * 4)
  body.writeInt32BE(values.length, 0)
  values.forEach((value, at) => body.writeInt32BE(value, 4 + at * 4))

  return Buffer.concat([name(INT_ARRAY, label), body])
}

/** A compound, closed with the end tag its contents do not carry themselves. */
function compound(label: string, body: Buffer): Buffer {
  return Buffer.concat([name(COMPOUND, label), body, Buffer.from([0])])
}

/** The format's block data is varints, one per position, however small the palette is. */
function varint(out: number[], value: number): void {
  let rest = value
  for (;;) {
    if ((rest & ~0x7f) === 0) {
      out.push(rest)
      return
    }
    out.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
}

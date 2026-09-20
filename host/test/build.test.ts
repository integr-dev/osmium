import { describe, expect, it } from 'vitest'

import { DEFAULT_ORDER, parseOrder, positions, rankOf } from '../src/agent/order.ts'
import {
  blockCount,
  decodeSegment,
  httpBase,
  linearOf,
  positionOf,
  stateAt,
  type Segment,
} from '../src/agent/build/segment.ts'
import { bare, formatSpec, opposite, parseSpec, planFor, tuneFor } from '../src/agent/build/plan.ts'
import { itemFor } from '../src/agent/build/materials.ts'
import { buildSettingsFrom, DEFAULT_REACH, MOST_REACH } from '../src/agent/build/settings.ts'
import { compare } from '../src/agent/build/compare.ts'
import { orderedQueue } from '../src/agent/build/printer.ts'
import { layout, pack } from '../src/rig/layout.ts'

const at = (x: number, y: number, z: number) => ({ x, y, z })

/** A small segment, packed the way the backend packs one. */
function madeOf(states: [number, number, number, string][]): Segment {
  const min = at(10, 64, -5)
  const size = { x: 4, y: 3, z: 4 }

  const palette: string[] = []
  const rows = states
    .map(([x, y, z, state]) => {
      let index = palette.indexOf(state)
      if (index < 0) index = palette.push(state) - 1
      return { linear: ((y - min.y) * size.z + (z - min.z)) * size.x + (x - min.x), index }
    })
    .sort((a, b) => a.linear - b.linear)

  const names = palette.map((state) => Buffer.from(state, 'utf8'))
  const header = 4 + 2 + names.reduce((sum, name) => sum + 2 + name.length, 0) + 24 + 4
  const out = Buffer.alloc(header + rows.length * 6)

  let cursor = out.write('OSM1', 0, 'ascii')
  cursor = out.writeUInt16BE(palette.length, cursor)
  for (const name of names) {
    cursor = out.writeUInt16BE(name.length, cursor)
    cursor += name.copy(out, cursor)
  }
  for (const value of [min.x, min.y, min.z]) cursor = out.writeInt32BE(value, cursor)
  for (const value of [size.x, size.y, size.z]) cursor = out.writeUInt32BE(value, cursor)
  cursor = out.writeUInt32BE(rows.length, cursor)
  for (const row of rows) {
    cursor = out.writeUInt32BE(row.linear, cursor)
    cursor = out.writeUInt16BE(row.index, cursor)
  }

  return decodeSegment(new Uint8Array(out))
}

describe('reading a segment', () => {
  const segment = madeOf([
    [10, 64, -5, 'minecraft:stone'],
    [12, 65, -3, 'minecraft:oak_stairs[facing=east,half=top]'],
    [13, 66, -2, 'minecraft:stone'],
  ])

  it('reads back the blocks it was given', () => {
    expect(blockCount(segment)).toBe(3)
    expect(segment.palette).toEqual(['minecraft:stone', 'minecraft:oak_stairs[facing=east,half=top]'])
    expect(stateAt(segment, at(12, 65, -3))).toBe('minecraft:oak_stairs[facing=east,half=top]')
  })

  it('answers nothing for a square the piece does not fill', () => {
    expect(stateAt(segment, at(11, 64, -5))).toBeUndefined()
  })

  it('answers nothing for a square outside the box', () => {
    expect(linearOf(segment, at(9, 64, -5))).toBeUndefined()
    expect(linearOf(segment, at(10, 64, -9))).toBeUndefined()
    expect(linearOf(segment, at(14, 64, -5))).toBeUndefined()
    expect(stateAt(segment, at(100, 64, -5))).toBeUndefined()
  })

  it('turns a position into an index and back', () => {
    for (const spot of [at(10, 64, -5), at(13, 66, -2), at(11, 65, -4)]) {
      expect(positionOf(segment, linearOf(segment, spot)!)).toEqual(spot)
    }
  })

  it('refuses a body that is not a segment', () => {
    expect(() => decodeSegment(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/not a segment/i)
  })

  it('refuses a body that ends inside itself', () => {
    const whole = madeOf([[10, 64, -5, 'minecraft:stone']])
    const bytes = packOf(whole)
    expect(() => decodeSegment(bytes.subarray(0, bytes.length - 3))).toThrow(/ends inside/i)
  })
})

/** The rig's packer, which writes the same bytes the backend serves. */
function packOf(segment: Segment): Uint8Array {
  const names = segment.palette.map((state) => Buffer.from(state, 'utf8'))
  const header = 4 + 2 + names.reduce((sum, name) => sum + 2 + name.length, 0) + 24 + 4
  const out = Buffer.alloc(header + segment.linear.length * 6)

  let cursor = out.write('OSM1', 0, 'ascii')
  cursor = out.writeUInt16BE(segment.palette.length, cursor)
  for (const name of names) {
    cursor = out.writeUInt16BE(name.length, cursor)
    cursor += name.copy(out, cursor)
  }
  for (const value of [segment.min.x, segment.min.y, segment.min.z]) cursor = out.writeInt32BE(value, cursor)
  for (const value of [segment.size.x, segment.size.y, segment.size.z]) cursor = out.writeUInt32BE(value, cursor)
  cursor = out.writeUInt32BE(segment.linear.length, cursor)
  for (let index = 0; index < segment.linear.length; index += 1) {
    cursor = out.writeUInt32BE(segment.linear[index]! >>> 0, cursor)
    cursor = out.writeUInt16BE(segment.states[index]!, cursor)
  }

  return new Uint8Array(out)
}

describe('where a piece is fetched from', () => {
  it('is the same Osmium the commands come from', () => {
    expect(httpBase('ws://localhost:8080/ws/host')).toBe('http://localhost:8080')
    expect(httpBase('wss://osmium.example/ws/host')).toBe('https://osmium.example')
  })
})

describe('reading a block state', () => {
  it('splits a name from its properties, and puts them back', () => {
    const spec = parseSpec('minecraft:oak_stairs[half=top,facing=east]')
    expect(spec.name).toBe('minecraft:oak_stairs')
    expect(spec.properties).toEqual({ half: 'top', facing: 'east' })
    // Sorted, which is what makes two spellings of one state one palette entry.
    expect(formatSpec(spec)).toBe('minecraft:oak_stairs[facing=east,half=top]')
    expect(bare('minecraft:stone')).toBe('stone')
  })
})

describe('planning a placement', () => {
  it('takes a pillar from either face along its axis', () => {
    const plan = planFor('minecraft:oak_log[axis=x]')
    expect(plan.options.map((option) => option.against)).toEqual(['west', 'east'])
  })

  it('reads a stair half off the hit point when there is no face for it', () => {
    const top = planFor('minecraft:oak_stairs[facing=east,half=top]')
    expect(top.options[0]).toEqual({ against: 'up', yaw: 'east' })
    // The sideways ways all aim high on the face, which is what makes the half top.
    for (const option of top.options.slice(1)) expect(option.cursor).toEqual({ y: 0.9 })

    const bottom = planFor('minecraft:oak_stairs[facing=east,half=bottom]')
    expect(bottom.options[0]).toEqual({ against: 'down', yaw: 'east' })
  })

  it('places a double slab twice', () => {
    expect(planFor('minecraft:stone_slab[type=double]').copies).toBe(2)
    expect(planFor('minecraft:stone_slab[type=top]').copies).toBe(1)
    expect(planFor('minecraft:snow[layers=5]').copies).toBe(5)
    // Clamped rather than trusted: a count nobody expects is a placement loop with no end.
    expect(planFor('minecraft:candle[candles=99]').copies).toBe(4)
  })

  it('leaves the half that comes free alone', () => {
    expect(planFor('minecraft:oak_door[facing=north,half=upper,hinge=left]').free).toBe(true)
    expect(planFor('minecraft:red_bed[facing=north,part=head]').free).toBe(true)
    expect(planFor('minecraft:oak_door[facing=north,half=lower,hinge=left]').free).toBe(false)
  })

  it('offers no way that would make the wrong state', () => {
    // A hopper takes its facing from the face clicked, so there is exactly one face that produces
    // the state asked for. Falling back to another one is how a hopper ends up pointing at the
    // floor because the wall behind it had not arrived yet.
    const plan = planFor('minecraft:hopper[facing=south]')
    expect(plan.options).toEqual([{ against: 'south' }])
  })

  it('knows which way round each six-sided block reads the look', () => {
    // Measured against a server, not remembered - see `rig probe`.
    expect(planFor('minecraft:observer[facing=north]').options[0]?.nearest).toBe('north')
    expect(planFor('minecraft:dropper[facing=north]').options[0]?.nearest).toBe('south')
    expect(planFor('minecraft:piston[facing=up]').options[0]?.nearest).toBe('down')
  })

  it('turns the agent a quarter turn for an anvil', () => {
    expect(planFor('minecraft:anvil[facing=north]').options[0]?.yaw).toBe('west')
  })

  it('hangs a wall block on the block it points away from', () => {
    expect(planFor('minecraft:wall_torch[facing=east]').options).toEqual([{ against: 'west' }])
    expect(planFor('minecraft:ladder[facing=north]').options).toEqual([{ against: 'south' }])
    expect(planFor('minecraft:oak_wall_sign[facing=west]').options).toEqual([{ against: 'east' }])
  })

  it('turns a standing sign to one of sixteen', () => {
    const plan = planFor('minecraft:oak_sign[rotation=7]')
    expect(plan.options).toEqual([{ against: 'down', rotation: 7 }])
    expect(plan.drift).not.toContain('rotation')
  })

  it('treats a plain cube as placeable from anywhere', () => {
    expect(planFor('minecraft:stone').options).toHaveLength(6)
    expect(planFor('minecraft:stone').drift).toEqual([])
  })

  it('says what neither placing nor clicking can reach', () => {
    expect(planFor('minecraft:oak_stairs[facing=east,half=top,waterlogged=true]').drift).toContain('waterlogged')
    // What the world works out for itself is not drift: the fence connects when its neighbour lands.
    expect(planFor('minecraft:oak_fence[east=true,north=false]').drift).toEqual([])
  })
})

describe('finishing a state by clicking', () => {
  const clicks = (state: string, property: string, have: string, want: string) =>
    tuneFor(state).find((knob) => knob.property === property)?.clicks(have, want)

  it('counts a repeater round its four delays', () => {
    expect(clicks('minecraft:repeater[delay=3]', 'delay', '1', '3')).toBe(2)
    // It wraps rather than going backwards, because the click only goes one way.
    expect(clicks('minecraft:repeater[delay=1]', 'delay', '3', '1')).toBe(2)
    expect(clicks('minecraft:repeater[delay=2]', 'delay', '2', '2')).toBe(0)
  })

  it('toggles what has two values', () => {
    expect(clicks('minecraft:comparator[mode=subtract]', 'mode', 'compare', 'subtract')).toBe(1)
    expect(clicks('minecraft:oak_trapdoor[open=true]', 'open', 'false', 'true')).toBe(1)
    expect(clicks('minecraft:lever[powered=true]', 'powered', 'true', 'true')).toBe(0)
  })

  it('counts a note block round its twenty-five pitches', () => {
    expect(clicks('minecraft:note_block[note=13]', 'note', '0', '13')).toBe(13)
    expect(clicks('minecraft:note_block[note=2]', 'note', '24', '2')).toBe(3)
  })

  it('leaves alone what a click does not change', () => {
    expect(tuneFor('minecraft:stone')).toEqual([])
    expect(tuneFor('minecraft:furnace[facing=north,lit=true]')).toEqual([])
  })

  it('does not report as drift what it can click into place', () => {
    expect(planFor('minecraft:repeater[facing=north,delay=4]').drift).not.toContain('delay')
    // A lit furnace is not something a click reaches, so it stays drift.
    expect(planFor('minecraft:furnace[facing=north,lit=true]').drift).toContain('lit')
  })
})

describe('what to hold', () => {
  it('is the block itself, almost always', () => {
    expect(itemFor('minecraft:oak_stairs[facing=east]')).toBe('oak_stairs')
    expect(itemFor('minecraft:stone')).toBe('stone')
  })

  it('is the standing form of anything hung on a wall', () => {
    expect(itemFor('minecraft:wall_torch[facing=east]')).toBe('torch')
    expect(itemFor('minecraft:oak_wall_sign[facing=east]')).toBe('oak_sign')
    expect(itemFor('minecraft:white_wall_banner[facing=east]')).toBe('white_banner')
  })

  it('is the seed of a crop, and nothing at all for what no item places', () => {
    expect(itemFor('minecraft:wheat[age=7]')).toBe('wheat_seeds')
    expect(itemFor('minecraft:cocoa[facing=north]')).toBe('cocoa_beans')
    expect(itemFor('minecraft:piston_head[facing=up]')).toBeUndefined()
    expect(itemFor('minecraft:nether_portal[axis=x]')).toBeUndefined()
  })
})

describe('build settings', () => {
  it('falls back to the defaults for anything that is not a number', () => {
    const settings = buildSettingsFrom({ 'build.reach': 'soon', 'build.rate': '' })
    expect(settings.reach).toBe(DEFAULT_REACH)
    expect(settings.rate).toBe(12)
  })

  it('holds a number to what the game will accept', () => {
    expect(buildSettingsFrom({ 'build.reach': '40' }).reach).toBe(MOST_REACH)
    expect(buildSettingsFrom({ 'build.reach': '0.1' }).reach).toBe(1)
  })

  it('finishes states unless told not to', () => {
    expect(buildSettingsFrom({}).tune).toBe(true)
    expect(buildSettingsFrom({ 'build.tune': 'false' }).tune).toBe(false)
  })
})

describe('comparing what was asked for with what is standing', () => {
  it('reports a wrong block on its own', () => {
    const misses = compare('minecraft:oak_stairs[facing=east]', { name: 'stone', properties: {} })
    expect(misses).toEqual([{ property: 'block', want: 'oak_stairs', have: 'stone' }])
  })

  it('reports an empty square as air', () => {
    expect(compare('minecraft:stone', undefined)).toEqual([{ property: 'block', want: 'stone', have: 'air' }])
  })

  it('reports every property that differs', () => {
    const misses = compare('minecraft:oak_stairs[facing=east,half=top]', {
      name: 'oak_stairs',
      properties: { facing: 'west', half: 'top', shape: 'straight' },
    })
    expect(misses).toEqual([{ property: 'facing', want: 'east', have: 'west' }])
  })

  it('says nothing about a property the wanted state does not name', () => {
    expect(compare('minecraft:stone', { name: 'stone', properties: { waterlogged: 'true' } })).toEqual([])
  })
})

describe('the order a piece is placed in', () => {
  const min = at(0, 0, 0)
  const max = at(2, 2, 2)

  it('ranks a position exactly where the walk puts it', () => {
    for (const token of ['y+z+x+', 'y+z+x+s', 'x-z+y-', 'z-y+x-s']) {
      const order = parseOrder(token)!
      const walk = [...positions(min, max, order)]
      walk.forEach((spot, step) => {
        expect(rankOf(min, max, order, spot), `${token} at ${step}`).toBe(step)
      })
    }
  })

  it('has no rank for a position outside the box', () => {
    expect(rankOf(min, max, DEFAULT_ORDER, at(3, 0, 0))).toBeUndefined()
    expect(rankOf(min, max, DEFAULT_ORDER, at(0, -1, 0))).toBeUndefined()
  })

  it('sorts a piece into the order it was given', () => {
    const segment = madeOf([
      [13, 66, -2, 'minecraft:stone'],
      [10, 64, -5, 'minecraft:stone'],
      [12, 65, -3, 'minecraft:stone'],
    ])

    const queue = orderedQueue(segment, DEFAULT_ORDER)
    const walked = [...queue].map((index) => positionOf(segment, segment.linear[index]! >>> 0))
    expect(walked.map((spot) => spot.y)).toEqual([64, 65, 66])

    const down = orderedQueue(segment, parseOrder('y-z+x+')!)
    const backwards = [...down].map((index) => positionOf(segment, segment.linear[index]! >>> 0))
    expect(backwards.map((spot) => spot.y)).toEqual([66, 65, 64])
  })
})

describe('the rig', () => {
  it('packs a schematic every family of the plan can be read out of', () => {
    const view = layout(at(0, -59, 0))
    const segment = decodeSegment(pack(view))

    expect(view.plots.length).toBeGreaterThan(100)
    expect(blockCount(segment)).toBe(view.blocks.length)

    // Every specimen's square holds the state the specimen is named for.
    for (const plot of view.plots) {
      const wanted = view.blocks.find(
        (block) =>
          block.at.x === plot.target.x && block.at.y === plot.target.y && block.at.z === plot.target.z,
      )
      expect(wanted, plot.name).toBeDefined()
      expect(stateAt(segment, plot.target), plot.name).toBe(wanted!.state)
    }
  })

  it('leaves a square of air between the pedestals, so nothing connects to its neighbour', () => {
    const view = layout(at(0, -59, 0))
    const filled = new Set(view.blocks.map((block) => `${block.at.x},${block.at.y},${block.at.z}`))

    for (const plot of view.plots) {
      for (let y = 0; y < 4; y += 1) {
        expect(filled.has(`${plot.origin.x + 3},${plot.origin.y + y},${plot.origin.z}`), plot.name).toBe(false)
        expect(filled.has(`${plot.origin.x},${plot.origin.y + y},${plot.origin.z + 3}`), plot.name).toBe(false)
      }
    }
  })

  it('knows how to place every state it asks for', () => {
    const view = layout(at(0, -59, 0))

    for (const block of view.blocks) {
      const plan = planFor(block.state)
      if (plan.free) continue

      expect(itemFor(block.state), block.state).toBeDefined()
      expect(plan.options.length, block.state).toBeGreaterThan(0)
    }
  })
})

describe('directions', () => {
  it('turn round', () => {
    expect(opposite('north')).toBe('south')
    expect(opposite('up')).toBe('down')
    expect(opposite(opposite('east'))).toBe('east')
  })
})

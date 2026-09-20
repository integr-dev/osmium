/**
 * A schematic made entirely of the blocks that are hard to place.
 *
 * A build made of stone says nothing about a printer: every cube comes out the same whichever face
 * was clicked and whichever way the agent was looking. What a printer gets wrong is the other kind —
 * stairs that come out mirrored, trapdoors on the wrong half of the square, a repeater on the wrong
 * tick — and none of that shows up until somebody builds one and looks at it.
 *
 * So this is one: a grid of small pedestals, one state per pedestal, covering every placement family
 * `agent/build/plan.ts` claims to know. The rig builds it, reads the world back, and reports which
 * pedestals came out as something other than what they say. A rule in the plan that is the wrong way
 * round is then a named line in a report rather than a build somebody notices is mirrored a week
 * later.
 *
 * **Each pedestal carries its own scaffolding.** What a block can be placed against is most of what
 * decides its state, so a specimen that needs a wall to hang on comes with one and a specimen that
 * hangs from a ceiling comes with a canopy over it. The canopy is deliberately built *after* the
 * block that hangs from it, which is the case the printer's second sweep exists for.
 */

export interface Cell {
  x: number
  y: number
  z: number
}

export interface Placed {
  at: Cell
  state: string
}

/**
 * What a specimen needs around it.
 *
 * - `flat`: a floor and nothing else, for blocks that spread sideways — a bed, snow, a candle.
 * - `pedestal`: a floor and a ring of stone around the square, so all four sides are walls.
 * - `canopy`: a floor, two pillars and a roof over the square, for anything that hangs.
 */
export type Scaffold = 'flat' | 'pedestal' | 'canopy'

export interface Specimen {
  /** What it exercises, and what a failing line in the report is named after. */
  name: string
  scaffold: Scaffold
  /** The blocks under test, relative to the pedestal's own corner. */
  blocks: Placed[]
}

/** The square every specimen puts its block in. */
export const TARGET: Cell = { x: 1, y: 1, z: 1 }

/** How far apart the pedestals stand: three across and a gap, so nothing connects to its neighbour. */
export const PITCH = 4

/** What everything is built out of when it is not the thing being tested. */
const STONE = 'minecraft:stone'

type Face = 'down' | 'up' | 'north' | 'south' | 'east' | 'west'

const AROUND: Face[] = ['north', 'south', 'east', 'west']
const EVERY: Face[] = ['down', 'up', 'north', 'south', 'east', 'west']

const STEP: Record<Face, Cell> = {
  down: { x: 0, y: -1, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 },
}

/** One block in the target square, which is what most specimens are. */
function one(name: string, scaffold: Scaffold, state: string): Specimen {
  return { name, scaffold, blocks: [{ at: TARGET, state }] }
}

/** The same state once per direction, named after the direction. */
function perFace(
  name: string,
  scaffold: Scaffold,
  faces: readonly Face[],
  state: (face: Face) => string,
): Specimen[] {
  return faces.map((face) => one(`${name}/${face}`, scaffold, state(face)))
}

/**
 * Everything the rig builds, in the order the cells are laid out.
 *
 * Grouped by family rather than by block, because that is how a failure reads: one wrong rule in the
 * plan shows up as every specimen of one family missing the same property.
 */
export function specimens(): Specimen[] {
  const out: Specimen[] = []

  // --- the halves: what the hit point on the clicked face decides -------------------

  for (const half of ['bottom', 'top'] as const) {
    out.push(...perFace('stairs', 'pedestal', AROUND, (face) => `minecraft:oak_stairs[facing=${face},half=${half}]`))
  }
  for (const type of ['bottom', 'top', 'double'] as const) {
    out.push(one(`slab/${type}`, 'pedestal', `minecraft:stone_slab[type=${type}]`))
  }

  // --- the axis: what the clicked face's axis decides ------------------------------

  for (const axis of ['x', 'y', 'z'] as const) {
    out.push(one(`log/${axis}`, 'pedestal', `minecraft:oak_log[axis=${axis}]`))
    out.push(one(`chain/${axis}`, 'pedestal', `minecraft:chain[axis=${axis}]`))
  }

  // --- facing the agent: the yaw, turned around ------------------------------------

  out.push(...perFace('furnace', 'pedestal', AROUND, (face) => `minecraft:furnace[facing=${face}]`))
  out.push(...perFace('chest', 'pedestal', AROUND, (face) => `minecraft:chest[facing=${face}]`))
  out.push(
    ...perFace('glazed', 'pedestal', AROUND, (face) => `minecraft:white_glazed_terracotta[facing=${face}]`),
  )
  out.push(...perFace('jack', 'pedestal', AROUND, (face) => `minecraft:jack_o_lantern[facing=${face}]`))
  out.push(...perFace('anvil', 'pedestal', AROUND, (face) => `minecraft:anvil[facing=${face}]`))

  // --- facing away from the agent: the yaw, as it is -------------------------------

  out.push(...perFace('campfire', 'pedestal', AROUND, (face) => `minecraft:campfire[facing=${face}]`))
  out.push(...perFace('gate', 'pedestal', AROUND, (face) => `minecraft:oak_fence_gate[facing=${face}]`))

  // --- six ways, read off the look -------------------------------------------------

  out.push(...perFace('observer', 'pedestal', EVERY, (face) => `minecraft:observer[facing=${face}]`))
  out.push(...perFace('dropper', 'pedestal', EVERY, (face) => `minecraft:dropper[facing=${face}]`))
  out.push(...perFace('barrel', 'pedestal', EVERY, (face) => `minecraft:barrel[facing=${face}]`))
  out.push(...perFace('piston', 'pedestal', EVERY, (face) => `minecraft:piston[facing=${face}]`))

  // --- the clicked face itself ------------------------------------------------------

  out.push(
    ...perFace('hopper', 'pedestal', ['down', ...AROUND], (face) => `minecraft:hopper[facing=${face}]`),
  )
  out.push(...perFace('ladder', 'pedestal', AROUND, (face) => `minecraft:ladder[facing=${face}]`))
  out.push(...perFace('torch', 'pedestal', AROUND, (face) => `minecraft:wall_torch[facing=${face}]`))
  out.push(...perFace('sign/wall', 'pedestal', AROUND, (face) => `minecraft:oak_wall_sign[facing=${face}]`))
  out.push(
    ...perFace('rod', 'pedestal', ['up', ...AROUND], (face) => `minecraft:end_rod[facing=${face}]`),
  )
  out.push(one('rod/down', 'canopy', 'minecraft:end_rod[facing=down]'))

  // --- two blocks tall, and only the lower one is placed ----------------------------

  for (const hinge of ['left', 'right'] as const) {
    for (const face of AROUND) {
      out.push({
        name: `door/${face}/${hinge}`,
        scaffold: 'flat',
        blocks: [
          { at: TARGET, state: `minecraft:oak_door[facing=${face},half=lower,hinge=${hinge}]` },
          { at: above(TARGET), state: `minecraft:oak_door[facing=${face},half=upper,hinge=${hinge}]` },
        ],
      })
    }
  }

  for (const face of AROUND) {
    const head = step(TARGET, face)
    out.push({
      name: `bed/${face}`,
      scaffold: 'flat',
      blocks: [
        { at: TARGET, state: `minecraft:red_bed[facing=${face},part=foot]` },
        { at: head, state: `minecraft:red_bed[facing=${face},part=head]` },
      ],
    })
  }

  // --- trapdoors, which read the face and the hit point both ------------------------

  for (const half of ['bottom', 'top'] as const) {
    out.push(
      ...perFace(
        `trapdoor/${half}`,
        'pedestal',
        AROUND,
        (face) => `minecraft:oak_trapdoor[facing=${face},half=${half}]`,
      ),
    )
  }
  out.push(one('trapdoor/open', 'pedestal', 'minecraft:oak_trapdoor[facing=north,half=bottom,open=true]'))

  // --- stuck to a surface, and then turned ------------------------------------------

  out.push(
    ...perFace('button/floor', 'pedestal', AROUND, (face) => `minecraft:stone_button[face=floor,facing=${face}]`),
  )
  out.push(
    ...perFace('button/wall', 'pedestal', AROUND, (face) => `minecraft:stone_button[face=wall,facing=${face}]`),
  )
  out.push(
    ...perFace('button/ceiling', 'canopy', AROUND, (face) => `minecraft:stone_button[face=ceiling,facing=${face}]`),
  )
  out.push(...perFace('lever/floor', 'pedestal', AROUND, (face) => `minecraft:lever[face=floor,facing=${face}]`))
  out.push(...perFace('lever/wall', 'pedestal', AROUND, (face) => `minecraft:lever[face=wall,facing=${face}]`))
  out.push(
    ...perFace('grindstone/floor', 'pedestal', AROUND, (face) => `minecraft:grindstone[face=floor,facing=${face}]`),
  )
  out.push(
    ...perFace('grindstone/wall', 'pedestal', AROUND, (face) => `minecraft:grindstone[face=wall,facing=${face}]`),
  )

  out.push(one('lantern/standing', 'pedestal', 'minecraft:lantern[hanging=false]'))
  out.push(one('lantern/hanging', 'canopy', 'minecraft:lantern[hanging=true]'))

  out.push(...perFace('bell/floor', 'pedestal', AROUND, (face) => `minecraft:bell[attachment=floor,facing=${face}]`))
  out.push(
    ...perFace('bell/ceiling', 'canopy', AROUND, (face) => `minecraft:bell[attachment=ceiling,facing=${face}]`),
  )
  out.push(
    ...perFace(
      'bell/wall',
      'pedestal',
      AROUND,
      (face) => `minecraft:bell[attachment=double_wall,facing=${face}]`,
    ),
  )

  // --- a sixteenth of a turn ---------------------------------------------------------

  for (const rotation of [0, 3, 7, 12, 15]) {
    out.push(one(`sign/${rotation}`, 'flat', `minecraft:oak_sign[rotation=${rotation}]`))
  }

  // --- placed once and then clicked ---------------------------------------------------

  out.push(...perFace('repeater', 'pedestal', AROUND, (face) => `minecraft:repeater[facing=${face},delay=1]`))
  for (const delay of [2, 3, 4]) {
    out.push(one(`repeater/delay${delay}`, 'pedestal', `minecraft:repeater[facing=north,delay=${delay}]`))
  }

  out.push(
    ...perFace('comparator', 'pedestal', AROUND, (face) => `minecraft:comparator[facing=${face},mode=compare]`),
  )
  out.push(one('comparator/subtract', 'pedestal', 'minecraft:comparator[facing=north,mode=subtract]'))

  for (const note of [0, 5, 13, 24]) {
    out.push(one(`note/${note}`, 'flat', `minecraft:note_block[note=${note}]`))
  }

  // --- placed more than once -----------------------------------------------------------

  for (const candles of [1, 2, 3, 4]) {
    out.push(one(`candle/${candles}`, 'flat', `minecraft:candle[candles=${candles}]`))
  }
  for (const layers of [1, 3, 8]) {
    out.push(one(`snow/${layers}`, 'flat', `minecraft:snow[layers=${layers}]`))
  }

  return out
}

/** One specimen, scaffolding and all, in its own coordinates. */
export function build(specimen: Specimen): Placed[] {
  const out: Placed[] = []

  // The floor. Every scaffold has one, and it is what the block under test usually stands on.
  for (let x = 0; x < 3; x += 1) {
    for (let z = 0; z < 3; z += 1) out.push({ at: { x, y: 0, z }, state: STONE })
  }

  if (specimen.scaffold === 'pedestal') {
    // A wall on all four sides, so a block that hangs on one has one whichever way it faces.
    for (let x = 0; x < 3; x += 1) {
      for (let z = 0; z < 3; z += 1) {
        if (x === 1 && z === 1) continue
        out.push({ at: { x, y: 1, z }, state: STONE })
      }
    }
  }

  if (specimen.scaffold === 'canopy') {
    // Two pillars and a lid. The lid is one layer above the block that hangs from it, so a
    // bottom-up order reaches the block first and has to come back for it - which is the case the
    // printer's second sweep is for, and the reason this is built this way round rather than the
    // convenient one.
    for (const x of [0, 2]) {
      out.push({ at: { x, y: 1, z: 1 }, state: STONE })
      out.push({ at: { x, y: 2, z: 1 }, state: STONE })
    }
    out.push({ at: { x: 1, y: 2, z: 1 }, state: STONE })
  }

  out.push(...specimen.blocks)
  return out
}

function above(cell: Cell): Cell {
  return { x: cell.x, y: cell.y + 1, z: cell.z }
}

function step(cell: Cell, face: Face): Cell {
  const by = STEP[face]
  return { x: cell.x + by.x, y: cell.y + by.y, z: cell.z + by.z }
}

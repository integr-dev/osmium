import type { BlockPos } from '../../protocol/wire.ts'

/**
 * How to produce one block state by placing a block, and what to do to it afterwards.
 *
 * A schematic says `minecraft:oak_stairs[facing=east,half=top]`. A client cannot say that; it can
 * only stand somewhere, look somewhere, and right-click a face of a block that is already there.
 * Everything else — which way the stairs end up pointing, whether the slab sits high or low, which
 * side the door hinges on — is the server deriving a state from those three things. This file is
 * that derivation, written backwards.
 *
 * **A table of families, not of blocks.** Vanilla decides placement in a handful of shapes and
 * shares them across hundreds of blocks: everything with an `axis` takes it from the clicked face,
 * everything that faces the player reads one yaw. Naming the families keeps this a page rather than
 * a registry, and a block nobody has classified falls through to "any face will do", which is right
 * for the thousands of plain cubes.
 *
 * **Placing is not the whole job.** A repeater comes out of the hand on one tick and a comparator
 * in compare mode, whatever the schematic wanted; those are set by right-clicking the block after
 * it is down. {@link tuneFor} says which properties a block cycles and how many clicks it takes,
 * and the printer follows a placement with them — see `printer.ts`. What neither can reach is
 * reported as {@link Plan.drift} rather than quietly accepted.
 *
 * **It is checked against a server, not against memory.** `src/rig` builds a schematic made of
 * exactly the awkward cases and reads back what the server made of it, so an entry here that is the
 * wrong way round is a failing line in a report rather than a build that comes out mirrored.
 */

export type Face = 'down' | 'up' | 'north' | 'south' | 'east' | 'west'

export const FACES: readonly Face[] = ['down', 'up', 'north', 'south', 'east', 'west']

/** The step from a block to its neighbour across that face. */
export const STEP: Record<Face, BlockPos> = {
  down: { x: 0, y: -1, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 },
}

const OPPOSITE: Record<Face, Face> = {
  down: 'up',
  up: 'down',
  north: 'south',
  south: 'north',
  west: 'east',
  east: 'west',
}

export function opposite(face: Face): Face {
  return OPPOSITE[face]
}

export function isHorizontal(face: Face): face is 'north' | 'south' | 'east' | 'west' {
  return face !== 'up' && face !== 'down'
}

/** A block state as the wire spells it: a name and the properties that pick this state of it. */
export interface BlockSpec {
  name: string
  properties: Record<string, string>
}

export function parseSpec(spec: string): BlockSpec {
  const open = spec.indexOf('[')
  if (open < 0) return { name: spec.trim(), properties: {} }

  const name = spec.slice(0, open).trim()
  const close = spec.lastIndexOf(']')
  const body = close > open ? spec.slice(open + 1, close) : ''

  const properties: Record<string, string> = {}
  for (const pair of body.split(',')) {
    const equals = pair.indexOf('=')
    if (equals < 0) continue
    properties[pair.slice(0, equals).trim()] = pair.slice(equals + 1).trim()
  }

  return { name, properties }
}

/** The inverse, with properties sorted — the same spelling the backend's palette uses. */
export function formatSpec(spec: BlockSpec): string {
  const keys = Object.keys(spec.properties).sort()
  if (keys.length === 0) return spec.name

  return `${spec.name}[${keys.map((key) => `${key}=${spec.properties[key]}`).join(',')}]`
}

/** The short name, `oak_stairs` rather than `minecraft:oak_stairs`. */
export function bare(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

/**
 * One way of placing the block: which neighbour to click, where on it, and how to be standing.
 *
 * Several per plan, in preference order, because which neighbours exist is not known here. The
 * first one whose reference block is already standing is the one used.
 */
export interface Option {
  /** The direction from the target to the block we click. Its opposite is the face we click. */
  against: Face
  /**
   * Where the cursor lands on the clicked block, as a fraction of it.
   *
   * Left out on the axes that do not matter, which the printer fills with the centre of the face.
   * The axes that do matter are the ones vanilla reads off the hit point: `y` for the half of a
   * stair, slab or trapdoor, `x` and `z` for which side a door hinges on.
   */
  cursor?: { x?: number; y?: number; z?: number }
  /** The horizontal direction the agent must be facing. */
  yaw?: Face
  /**
   * The axis-aligned direction the agent's look must be nearest to, for the blocks that read all
   * six rather than the four around them. Pitch straight up or down when it is vertical.
   */
  nearest?: Face
  /** For standing signs, banners and skulls: the sixteenth of a turn the block is set to. */
  rotation?: number
}

/**
 * A property a right-click cycles, and how far round it is from one value to another.
 *
 * Counted rather than toggled because the cycles are not all two long: a repeater's delay goes
 * round four and a note block's pitch round twenty-five, and clicking until it looks right is a
 * loop that never ends when the reading is stale.
 */
export interface Tune {
  property: string
  /** Clicks from `have` to `want`, or nothing when this cannot get there. */
  clicks(have: string, want: string): number | undefined
}

export interface Plan {
  /** Ways to place it, best first. Empty means nothing here knows how. */
  options: Option[]
  /** Right-clicks to make afterwards, in this order. Usually none. */
  tune: Tune[]
  /**
   * Properties neither placing nor clicking can reproduce — a waterlogged stair with no water to
   * hand, a campfire the schematic wants put out. Reported rather than silently accepted.
   */
  drift: string[]
  /** The upper half of a door, the head of a bed, the top of a tall flower: placed by its other
   * half, so placing it separately is a placement that fails. */
  free: boolean
  /**
   * How many times to place it into the same square.
   *
   * Two for a double slab, and as many as the schematic asks for candles, sea pickles or layers of
   * snow — all of which are one block that counts how often it was placed.
   */
  copies: number
  /**
   * Whether it falls when there is nothing underneath it.
   *
   * Sand, gravel, concrete powder, an anvil. Placing one over a hole does not fail — the block
   * goes in, the printer sees the right block in the right square, and a tick later it is a
   * block lower and the square is empty again. So the floor has to be there *first*, which is
   * something only the world can answer.
   */
  falls: boolean
}

/**
 * How to place a block into the empty square itself, when nothing is standing around it.
 *
 * **The click a neighbour would have taken, taken on air.** A placement names a square, a face of it
 * and a point on that face, and the server derives the state from the face, the point and the look —
 * not from what was clicked. Air is replaceable, so the block lands in the clicked square, and a click
 * there with the same face, the same point in the world (see {@link airCursor}) and the same look
 * makes the same block: a log lying the same way, a slab on the same half, a stair the same way up.
 * Measured with `rig probe --air` in open air, against the same probe on a neighbour: logs, slabs,
 * stairs and observers from every face and every look, identical.
 *
 * **Except a trapdoor clicked on its side.** Vanilla reads a trapdoor's facing off a side face only
 * when the clicked block is *not* being replaced, and in air it always is — so that click comes out
 * facing the way the agent looks, on the other half. Its click from above or below reads the look
 * either way and is the same in air; that is the one offered.
 *
 * A block that needs something to stand on or hang from — a torch, a door, a carpet, a ladder, a
 * lantern — is refused by the server's own survival check, which the probe found for every one of
 * them. Nothing here has to know which blocks those are.
 */
export function airOption(plan: Plan, name: string): Option | undefined {
  return plan.options.find((option) => !(name.endsWith('_trapdoor') && isHorizontal(option.against)))
}

/**
 * Where on the target square to click, to hit the point an option clicks on its neighbour.
 *
 * **The same point in the world, not the same numbers.** An option's cursor is measured on the block
 * it clicks, one step away from the target: the top face of the block below is `y = 1` on that
 * block, and the same point is `y = 0` on the target. Passing the numbers through unchanged moves the
 * hit a whole block, and every slab and stair placed that way comes out on the wrong half.
 */
export function airCursor(
  option: Option,
): { x: number; y: number; z: number } {
  const step = STEP[option.against]
  const normal = STEP[opposite(option.against)]

  return {
    x: (option.cursor?.x ?? 0.5 + normal.x * 0.5) + step.x,
    y: (option.cursor?.y ?? 0.5 + normal.y * 0.5) + step.y,
    z: (option.cursor?.z ?? 0.5 + normal.z * 0.5) + step.z,
  }
}

/** Faces to try when nothing about the state depends on which one is used. */
const ANY: Option[] = [
  { against: 'down' },
  { against: 'north' },
  { against: 'south' },
  { against: 'west' },
  { against: 'east' },
  { against: 'up' },
]

/**
 * What the server derives from the world rather than from the placement.
 *
 * A fence's `east`, a stair's `shape`, a wall's `up`: these follow from what ends up around the
 * block, so a build whose every block is right has them right without anybody aiming at them. They
 * are not drift — reporting them would bury the real misses under thousands of lines about fences
 * that will connect themselves as soon as the neighbour arrives.
 */
const DERIVED = new Set([
  'north',
  'south',
  'east',
  'west',
  'up',
  'shape',
  'in_wall',
  'attached',
  'disarmed',
  'signal_fire',
  'has_bottle_0',
  'has_bottle_1',
  'has_bottle_2',
  'has_record',
  'has_book',
  'occupied',
  'eggs',
  'hatch',
  'distance',
  'persistent',
  'leaves',
  'tilt',
  'thickness',
  'vertical_direction',
  'berries',
  'crafting',
  'triggered',
  'extended',
  'short',
  'bloom',
  'can_summon',
  'sculk_sensor_phase',
  'charges',
  'cracked',
  'slot_0_occupied',
  'slot_1_occupied',
  'slot_2_occupied',
  'slot_3_occupied',
  'slot_4_occupied',
  'slot_5_occupied',
  'dusted',
  'instrument',
  'snowy',
  'power',
  'locked',
  'unstable',
  'enabled',
])

/**
 * What a right-click after the fact changes, and placing never does.
 *
 * Whether the printer can actually get there is {@link tuneFor}'s answer, not this set's: this is
 * only the list of properties that placing has no say over, so that a block whose plan does not
 * tune them reports them as drift instead of pretending they came out right.
 */
const SET_BY_HAND = new Set([
  'delay',
  'mode',
  'open',
  'powered',
  'lit',
  'note',
  'level',
  'age',
  'bites',
  'honey_level',
  'inverted',
  'conditional',
  'waterlogged',
  'flower_amount',
  'candles',
  'pickles',
  'layers',
  'stage',
  'moisture',
  'orientation',
  'rotation',
])

/**
 * Blocks that fall when nothing is holding them up.
 *
 * The colours of concrete powder are matched by their suffix rather than listed; everything
 * else that falls is here by name.
 */
const FALLS = new Set([
  'sand',
  'red_sand',
  'suspicious_sand',
  'gravel',
  'suspicious_gravel',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
  'dragon_egg',
  'pointed_dripstone',
])

/** Blocks whose `facing` is the face of the support they were hung on. */
const HUNG = new Set([
  'wall_torch',
  'soul_wall_torch',
  'redstone_wall_torch',
  'ladder',
  'tripwire_hook',
  'end_rod',
  'lightning_rod',
  'amethyst_cluster',
  'large_amethyst_bud',
  'medium_amethyst_bud',
  'small_amethyst_bud',
  'cocoa',
])

/** Blocks whose `facing` is the horizontal direction the agent looked, turned around. */
const FACES_THE_AGENT = new Set([
  'furnace',
  'blast_furnace',
  'smoker',
  'chest',
  'trapped_chest',
  'ender_chest',
  'beehive',
  'bee_nest',
  'carved_pumpkin',
  'jack_o_lantern',
  'loom',
  'stonecutter',
  'lectern',
  'end_portal_frame',
  'repeater',
  'comparator',
  'big_dripleaf',
  'small_dripleaf',
  'chiseled_bookshelf',
  'decorated_pot',
])

/** Blocks whose `facing` is one of six, read off the agent's look and turned around. */
const FACES_THE_AGENT_IN_SIX = new Set([
  'dispenser',
  'dropper',
  'barrel',
  // Named outright as well as by its suffix: `sticky_piston` ends in one and `piston` is one.
  'piston',
  'crafter',
])

/**
 * Blocks whose `facing` is one of six, read off the agent's look and left as it is.
 *
 * One block, and it is worth its own set: an observer placed by the rule the hoppers and
 * droppers follow comes out back to front, which in a redstone build is a circuit that never
 * fires. Measured against a server rather than remembered — see `src/rig`.
 */
const FACES_AWAY_IN_SIX = new Set(['observer'])

/** Suffixes that say which family a block is in without naming every wood and stone in the game. */
const SUFFIX_FAMILIES: [string, string][] = [
  ['_glazed_terracotta', 'faces_the_agent'],
  ['_wall_torch', 'hung'],
  ['_wall_sign', 'wall_sign'],
  ['_wall_hanging_sign', 'wall_sign'],
  ['_wall_banner', 'wall_sign'],
  ['_wall_head', 'wall_sign'],
  ['_wall_skull', 'wall_sign'],
  ['_hanging_sign', 'standing_sign'],
  ['_sign', 'standing_sign'],
  ['_banner', 'standing_sign'],
  ['_head', 'standing_sign'],
  ['_skull', 'standing_sign'],
  ['_stairs', 'stairs'],
  ['_slab', 'slab'],
  ['_door', 'door'],
  ['_trapdoor', 'trapdoor'],
  ['_fence_gate', 'fence_gate'],
  ['_button', 'button'],
  ['_bed', 'bed'],
  ['_candle', 'candle'],
  ['_shulker_box', 'hung'],
  ['_piston', 'faces_the_agent_in_six'],
  ['_command_block', 'faces_the_agent_in_six'],
  ['_log', 'pillar'],
  ['_wood', 'pillar'],
  ['_stem', 'pillar'],
  ['_hyphae', 'pillar'],
  ['_pillar', 'pillar'],
  ['_block', 'maybe_pillar'],
]

/**
 * How to place one state.
 *
 * The shape of every branch is the same: work out which properties the placement has to produce,
 * turn each into a constraint on where the agent stands and what it clicks, and put everything left
 * over into {@link Plan.drift}.
 */
export function planFor(spec: string): Plan {
  const block = parseSpec(spec)
  const name = bare(block.name)
  const props = block.properties

  const tune = tuneFor(spec)
  const tuned = new Set(tune.map((entry) => entry.property))

  const drift: string[] = []
  for (const key of Object.keys(props)) {
    if (DERIVED.has(key) || tuned.has(key)) continue
    if (SET_BY_HAND.has(key)) drift.push(key)
  }

  // Half a two-block block. Placing the lower one puts this here, and aiming at it directly is a
  // click into thin air that fails.
  if (props['half'] === 'upper' || props['part'] === 'head') {
    return { options: [], tune: [], drift: [], free: true, copies: 1, falls: false }
  }

  const copies = copiesFor(name, props)
  const family = familyOf(name, props)
  const falls = FALLS.has(name) || name.endsWith('_concrete_powder')
  const made = (options: Option[]): Plan => ({ options, tune, drift, free: false, copies, falls })

  switch (family) {
    case 'pillar': {
      // `axis` is the axis of the face clicked, so either neighbour along it will do.
      const along: Record<string, Face[]> = { x: ['west', 'east'], y: ['down', 'up'], z: ['north', 'south'] }
      const faces = along[props['axis'] ?? '']
      if (!faces) break
      return made(faces.map((against) => ({ against })))
    }

    case 'slab':
      // `type=double` is two slabs in one square: the printer places the bottom and then places
      // again into it, which is what {@link Plan.copies} carries.
      return made(halfOptions(props['type'] === 'top' ? 'top' : 'bottom'))

    case 'stairs': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      // `facing` is the way the agent was looking, unturned. `half` comes off the hit point exactly
      // as it does for a slab, and `shape` is the server's business once the neighbours arrive.
      return made(
        halfOptions(props['half'] === 'top' ? 'top' : 'bottom').map((option) => ({ ...option, yaw: facing })),
      )
    }

    case 'trapdoor': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      const top = props['half'] === 'top'
      // Clicked from below or above, `facing` is the agent's horizontal direction turned around and
      // `half` is settled by which of the two it was. Clicking a side face instead sets `facing`
      // from the face and reads the half off the hit point, which is the fallback when neither
      // vertical neighbour is standing.
      return made([
        { against: top ? 'up' : 'down', yaw: opposite(facing) },
        { against: opposite(facing), cursor: { y: top ? 0.9 : 0.1 } },
      ])
    }

    case 'door': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      // Placed on the block below, because the hinge is read off where in the *door's* square the
      // click landed - which is only the same as the reference block's square when the reference is
      // directly underneath.
      return made([{ against: 'down', yaw: facing, cursor: hingeCursor(facing, props['hinge'] === 'right') }])
    }

    case 'bed':
    case 'campfire':
    case 'fence_gate': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      return made(ANY.map((option) => ({ ...option, yaw: facing })))
    }

    case 'faces_the_agent': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      return made(ANY.map((option) => ({ ...option, yaw: opposite(facing) })))
    }

    case 'faces_the_agent_in_six': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      // The agent's look, turned around: to make it face up, look down.
      return made(ANY.map((option) => ({ ...option, nearest: opposite(facing) })))
    }

    case 'faces_away_in_six': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      return made(ANY.map((option) => ({ ...option, nearest: facing })))
    }

    case 'hopper': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      // The face clicked, turned around, and never up - a hopper pointing at the ceiling is not a
      // state the game has, so `facing=down` is what a click from above or below both give.
      return made([{ against: facing === 'down' ? 'down' : facing }])
    }

    case 'hung':
    case 'wall_sign': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      // It hangs on the block across from where it points.
      return made([{ against: opposite(facing) }])
    }

    case 'standing_sign': {
      // A sixteenth of a turn rather than one of four, so the yaw is a number rather than a face.
      const rotation = Number(props['rotation'] ?? '0')
      const wanted = Number.isFinite(rotation) ? ((rotation % 16) + 16) % 16 : 0
      return {
        options: [{ against: 'down', rotation: wanted }],
        tune,
        drift: drift.filter((key) => key !== 'rotation'),
        free: false,
        copies,
        falls,
      }
    }

    case 'button':
    case 'lever':
    case 'grindstone': {
      const facing = faceOf(props['facing'])
      const face = props['face']
      if (!facing || !face) break
      // `face` says which surface it is stuck to and `facing` which way it then points. A floor
      // button is clicked from below and turned with the yaw; a wall one is clicked on the wall it
      // points away from.
      // On a wall the clicked face decides it outright: vanilla puts the opposite of the face
      // clicked at the front of the directions it considers, so the look never gets a say. On a
      // floor or a ceiling there is no such face, and the agent's own heading is what is read.
      if (face === 'wall') return made([{ against: opposite(facing) }])
      if (face === 'ceiling') return made([{ against: 'up', yaw: facing }])
      return made([{ against: 'down', yaw: facing }])
    }

    case 'lantern':
      return made(props['hanging'] === 'true' ? [{ against: 'up' }] : [{ against: 'down' }])

    case 'bell': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      const attachment = props['attachment']
      if (attachment === 'ceiling') return made([{ against: 'up', yaw: facing }])
      if (attachment === 'floor') return made([{ against: 'down', yaw: facing }])
      // A wall bell's facing runs along its beam into the wall rather than away from it, so
      // the block it hangs on is the one it points at.
      return made([{ against: facing }])
    }

    case 'anvil': {
      const facing = faceOf(props['facing'])
      if (!facing) break
      // Square on to the agent rather than facing it: the anvil's long side runs across the
      // look, and what comes out is the look turned clockwise - so aim a quarter turn back.
      return made(ANY.map((option) => ({ ...option, yaw: anticlockwise(facing) })))
    }

    case 'candle':
      return made(ANY)

    default:
      break
  }

  // Everything unclassified, and every branch above that could not read the property it needed. A
  // plain cube is the overwhelming majority of a build and has nothing to get wrong.
  const unresolved = Object.keys(props).filter(
    (key) => !DERIVED.has(key) && !SET_BY_HAND.has(key) && !tuned.has(key) && !drift.includes(key),
  )

  return { options: ANY, tune, drift: [...drift, ...unresolved], free: false, copies, falls }
}

/**
 * The right-clicks a block takes after it is down.
 *
 * Each entry counts the clicks between two values of one property rather than answering "is it
 * right yet", because the answer to that is a block read that may be a tick behind — and a loop
 * that clicks until a stale reading agrees is a loop that clicks forever.
 */
export function tuneFor(spec: string): Tune[] {
  const block = parseSpec(spec)
  const name = bare(block.name)
  const props = block.properties

  const steps = (property: string, values: readonly string[]): Tune => ({
    property,
    clicks: (have, want) => {
      const here = values.indexOf(have)
      const there = values.indexOf(want)
      if (here < 0 || there < 0) return undefined
      return (((there - here) % values.length) + values.length) % values.length
    },
  })

  // A repeater's delay runs 1, 2, 3, 4 and back to 1; a comparator's mode toggles. Both are why a
  // schematic full of redstone comes out looking right and working wrong.
  if (name === 'repeater' && props['delay']) return [steps('delay', ['1', '2', '3', '4'])]
  if (name === 'comparator' && props['mode']) return [steps('mode', ['compare', 'subtract'])]

  // Doors, trapdoors and gates all toggle `open`, and a lever toggles `powered`. Clicking a door
  // moves both of its halves, which is why only the lower one is ever placed or clicked.
  // Iron is the exception, and it is not a small one: an iron door or trapdoor opens for
  // redstone and for nothing else, so a hand on it does nothing at all. Clicking anyway spends
  // three rounds of clicks and re-reads per block on a state that was never going to move, and
  // reports it as drift afterwards either way.
  if (props['open'] !== undefined && !name.startsWith('iron_') && OPENABLE.some((suffix) => name.endsWith(suffix))) {
    return [steps('open', ['false', 'true'])]
  }
  if (name === 'lever' && props['powered'] !== undefined) return [steps('powered', ['false', 'true'])]

  if (name === 'daylight_detector' && props['inverted'] !== undefined) {
    return [steps('inverted', ['false', 'true'])]
  }

  // Twenty-five pitches, cycling. The instrument is the block underneath rather than anything the
  // clicking can reach, so it stays derived.
  if (name === 'note_block' && props['note'] !== undefined) {
    return [steps('note', NOTES)]
  }

  return []
}

/** What the world settles for itself once the neighbours land — see {@link DERIVED}. */
export function derived(property: string): boolean {
  return DERIVED.has(property)
}

const OPENABLE = ['_door', '_trapdoor', '_fence_gate']
const NOTES: readonly string[] = Array.from({ length: 25 }, (_, note) => String(note))

/**
 * How many times to place into the same square.
 *
 * One block, counted by how often it was placed: a double slab is two, and candles, sea pickles and
 * layers of snow are however many the schematic asks for.
 */
function copiesFor(name: string, props: Record<string, string>): number {
  if (props['type'] === 'double') return 2

  const counted = props['candles'] ?? props['pickles'] ?? props['layers']
  if (counted === undefined) return 1

  const count = Number(counted)
  if (!Number.isFinite(count) || count < 1) return 1

  // Snow reaches eight; the rest reach four. Clamped rather than trusted, since a count this build
  // does not expect would otherwise be a placement loop with no end.
  return Math.min(count, name === 'snow' ? 8 : 4)
}

/**
 * Where to click for the top or bottom half of a square.
 *
 * Vanilla reads it off the clicked face first and the hit point second: a click on the top face of
 * the block below is always the bottom half, one on the underside of the block above is always the
 * top, and a click on a side face is decided by how high up that face it landed.
 */
function halfOptions(half: 'top' | 'bottom'): Option[] {
  const sideways: Option[] = (['north', 'south', 'west', 'east'] as Face[]).map((against) => ({
    against,
    cursor: { y: half === 'top' ? 0.9 : 0.1 },
  }))

  return half === 'top' ? [{ against: 'up' }, ...sideways] : [{ against: 'down' }, ...sideways]
}

/**
 * Where in the door's square to click for the hinge to land on the wanted side.
 *
 * Vanilla only reads the hit point when neither neighbour decides it for free, and it reads it
 * against the door's own position rather than the block clicked — which is why a door is always
 * placed on the square below it.
 */
function hingeCursor(facing: Face, right: boolean): { x?: number; z?: number } {
  // Which half of the square is "left" flips with the facing, which is why this is four cases
  // rather than one: vanilla compares the hit point against the middle and reads the answer
  // through the facing's own step along that axis.
  const low = right ? 0.75 : 0.25
  const high = right ? 0.25 : 0.75

  switch (facing) {
    case 'north':
      return { x: low }
    case 'south':
      return { x: high }
    case 'east':
      return { z: low }
    case 'west':
      return { z: high }
    default:
      return {}
  }
}

/** A quarter turn widdershins: north becomes west. */
function anticlockwise(face: Face): Face {
  switch (face) {
    case 'north':
      return 'west'
    case 'west':
      return 'south'
    case 'south':
      return 'east'
    case 'east':
      return 'north'
    default:
      return face
  }
}

function faceOf(value: string | undefined): Face | undefined {
  return value !== undefined && (FACES as readonly string[]).includes(value) ? (value as Face) : undefined
}

/** Which of the placement shapes a block name falls into. */
function familyOf(name: string, props: Record<string, string>): string {
  if (name === 'hopper') return 'hopper'
  if (name === 'lantern' || name === 'soul_lantern') return 'lantern'
  if (name === 'bell') return 'bell'
  if (name === 'campfire' || name === 'soul_campfire') return 'campfire'
  if (name === 'candle' || name === 'sea_pickle' || name === 'snow') return 'candle'
  if (name === 'anvil' || name === 'chipped_anvil' || name === 'damaged_anvil') return 'anvil'
  if (name === 'lever') return 'lever'
  if (name === 'grindstone') return 'grindstone'
  if (name === 'chain') return 'pillar'
  if (HUNG.has(name)) return 'hung'
  if (FACES_AWAY_IN_SIX.has(name)) return 'faces_away_in_six'
  if (FACES_THE_AGENT_IN_SIX.has(name)) return 'faces_the_agent_in_six'
  if (FACES_THE_AGENT.has(name)) return 'faces_the_agent'

  for (const [suffix, family] of SUFFIX_FAMILIES) {
    if (!name.endsWith(suffix)) continue

    // `_block` is the one ambiguous suffix: a bone block is a pillar and a block of iron is a cube,
    // and only the state says which.
    if (family === 'maybe_pillar') return props['axis'] ? 'pillar' : 'plain'
    return family
  }

  if (props['axis']) return 'pillar'
  if (props['face'] && props['facing']) return 'button'

  return 'plain'
}

import { bare, parseSpec } from './plan.ts'

/**
 * The item that puts a block in the ground.
 *
 * Almost always the block's own name — `oak_stairs` is placed with `oak_stairs` — which is why this
 * is a list of exceptions rather than a registry. The exceptions are the blocks that exist only as
 * a consequence of something else being placed: a torch on a wall is a torch, a crop is a seed, and
 * a few of them are not placed by an item at all.
 *
 * A block with no item answers `undefined`, which parks it rather than failing the piece. Nothing
 * here is a judgement about whether a schematic should contain one; a captured build is full of
 * them, and the honest report is that the agent could not place them.
 */

const EXCEPTIONS: Record<string, string | undefined> = {
  // Hung on a wall by placing the ordinary one against it.
  wall_torch: 'torch',
  soul_wall_torch: 'soul_torch',
  redstone_wall_torch: 'redstone_torch',

  // Dust, not an ingot; and the two circuits whose block name is not their item name.
  redstone_wire: 'redstone',
  repeater: 'repeater',
  comparator: 'comparator',
  tripwire: 'string',

  // Crops. Every one of these is a seed, and the block is what the seed grows into.
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds',
  attached_melon_stem: 'melon_seeds',
  attached_pumpkin_stem: 'pumpkin_seeds',
  torchflower_crop: 'torchflower_seeds',
  pitcher_crop: 'pitcher_pod',
  cocoa: 'cocoa_beans',
  sweet_berry_bush: 'sweet_berries',
  cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries',
  bamboo_sapling: 'bamboo',
  kelp_plant: 'kelp',
  twisting_vines_plant: 'twisting_vines',
  weeping_vines_plant: 'weeping_vines',
  tall_seagrass: 'seagrass',

  // Fluids and the blocks that are really a fluid in something.
  water: 'water_bucket',
  lava: 'lava_bucket',
  powder_snow: 'powder_snow_bucket',
  bubble_column: undefined,

  // Cut from stone by a block that is not the one in the world.
  redstone_lamp: 'redstone_lamp',
  soul_fire: undefined,
  fire: undefined,
  nether_portal: undefined,
  end_portal: undefined,
  end_gateway: undefined,
  frosted_ice: undefined,
  moving_piston: undefined,
  piston_head: undefined,
  air: undefined,
  cave_air: undefined,
  void_air: undefined,
  light: undefined,
  structure_void: undefined,
  barrier: 'barrier',

  // A cake with a candle in it is two items, and the printer places the cake.
  candle_cake: 'cake',
  white_candle_cake: 'cake',
}

/**
 * What to hold to place this state.
 *
 * Takes the whole state rather than the name, because a couple of the exceptions depend on it: a
 * wall banner is the banner of its colour, and which colour is in the name.
 */
export function itemFor(spec: string): string | undefined {
  const name = bare(parseSpec(spec).name)

  if (name in EXCEPTIONS) return EXCEPTIONS[name]

  // The wall-mounted half of something that also stands on the ground. All of them are placed with
  // the standing item, against a wall instead of a floor.
  for (const [wall, floor] of WALL_FORMS) {
    if (name.endsWith(wall)) return name.slice(0, -wall.length) + floor
  }

  return name
}

/** Suffixes whose item is the same block without the `wall_` in it. */
const WALL_FORMS: [string, string][] = [
  ['_wall_sign', '_sign'],
  ['_wall_hanging_sign', '_hanging_sign'],
  ['_wall_banner', '_banner'],
  ['_wall_head', '_head'],
  ['_wall_skull', '_skull'],
  ['_wall_fan', '_fan'],
  ['_wall_torch', '_torch'],
]

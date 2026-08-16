/**
 * A colour per block, so the preview looks like the thing it is previewing.
 *
 * **Curated, not exhaustive, and deliberately so.** Minecraft has well over a thousand blocks and a
 * complete table would be a data file to generate, verify and keep in step with the game. What is
 * here is the couple of hundred that make up the *mass* of real builds — stone and its family, the
 * woods, the sixteen wools and concretes, glass, the ores, the common terrain — and everything else
 * falls through to a colour derived from its name.
 *
 * That fallback is what makes the partial table honest. An unlisted block is not grey and not
 * missing: it gets a stable, muted colour of its own, so two different unknowns look different and
 * the same unknown looks the same twice. What it does not get is a colour that means anything, and
 * the interface says the picture is a massing model rather than a render.
 *
 * Approximate averages, not sampled from textures. A voxel here is at best one block and usually
 * several, so precision past "which colour is this roughly" is precision nothing can show.
 */

const FAMILIES: Array<[RegExp, string]> = [
  // Order matters: the first pattern that matches wins, so the specific ones come before the
  // general. `dark_oak` has to be tried before `oak`, and `deepslate_*_ore` before `deepslate`.
  [/^(minecraft:)?(air|cave_air|void_air)$/, '#00000000'],

  [/light_gray_(wool|concrete|terracotta|carpet|glazed)/, '#9d9d97'],
  [/light_blue_(wool|concrete|terracotta|carpet|glazed)/, '#3ab3da'],
  [/(white)_(wool|concrete|terracotta|carpet|glazed)/, '#f9fffe'],
  [/(orange)_(wool|concrete|terracotta|carpet|glazed)/, '#f9801d'],
  [/(magenta)_(wool|concrete|terracotta|carpet|glazed)/, '#c74ebd'],
  [/(yellow)_(wool|concrete|terracotta|carpet|glazed)/, '#fed83d'],
  [/(lime)_(wool|concrete|terracotta|carpet|glazed)/, '#80c71f'],
  [/(pink)_(wool|concrete|terracotta|carpet|glazed)/, '#f38baa'],
  [/(gray)_(wool|concrete|terracotta|carpet|glazed)/, '#474f52'],
  [/(cyan)_(wool|concrete|terracotta|carpet|glazed)/, '#169c9c'],
  [/(purple)_(wool|concrete|terracotta|carpet|glazed)/, '#8932b8'],
  [/(blue)_(wool|concrete|terracotta|carpet|glazed)/, '#3c44aa'],
  [/(brown)_(wool|concrete|terracotta|carpet|glazed)/, '#835432'],
  [/(green)_(wool|concrete|terracotta|carpet|glazed)/, '#5e7c16'],
  [/(red)_(wool|concrete|terracotta|carpet|glazed)/, '#b02e26'],
  [/(black)_(wool|concrete|terracotta|carpet|glazed)/, '#1d1d21'],

  [/deepslate_(coal|iron|copper|gold|redstone|emerald|lapis|diamond)_ore/, '#4a4a4d'],
  [/(coal)_ore/, '#5d5d5d'],
  [/(iron)_ore/, '#a3846b'],
  [/(copper)_ore/, '#9a6e4d'],
  [/(gold)_ore/, '#a38b4a'],
  [/(redstone)_ore/, '#8b4d4d'],
  [/(emerald)_ore/, '#4b8a5f'],
  [/(lapis)_ore/, '#4a6b9a'],
  [/(diamond)_ore/, '#5a8f92'],

  [/dark_oak/, '#4a3319'],
  [/spruce/, '#6b4f2c'],
  [/birch/, '#c8b47c'],
  [/jungle/, '#a0763f'],
  [/acacia/, '#ba6337'],
  [/mangrove/, '#75342a'],
  [/cherry/, '#e0b0bd'],
  [/bamboo/, '#c2b444'],
  [/crimson/, '#7b3e5b'],
  [/warped/, '#3a8a80'],
  [/oak/, '#9c7f4e'],

  [/deepslate/, '#4a4a4d'],
  [/(cobblestone|cobbled)/, '#7d7d7d'],
  [/(andesite)/, '#8a8a8a'],
  [/(diorite)/, '#c7c7c1'],
  [/(granite)/, '#9a6c5b'],
  [/(calcite)/, '#dfdfd6'],
  [/(tuff)/, '#6b6b64'],
  [/(basalt|blackstone)/, '#3b3b40'],
  [/(sandstone)/, '#dbcd9a'],
  [/(red_sand)/, '#a95821'],
  [/(sand)/, '#dbd3a0'],
  [/(gravel)/, '#7f7b78'],
  [/(clay)/, '#a4a8b8'],
  [/(terracotta)/, '#985e43'],
  [/(bricks|brick)/, '#96604c'],
  [/(quartz)/, '#ebe5dc'],
  [/(prismarine)/, '#5f9187'],
  [/(purpur)/, '#a97ca9'],
  [/(end_stone)/, '#dbdf9e'],
  [/(netherrack)/, '#6b3535'],
  [/(nether_brick)/, '#3d2226'],
  [/(obsidian)/, '#15121e'],
  [/(bedrock)/, '#565656'],
  [/(stone|smooth_stone)/, '#7f7f7f'],

  [/(grass_block|moss)/, '#5d8a3a'],
  [/(dirt|podzol|mud|rooted)/, '#79553a'],
  [/(snow|powder_snow)/, '#f0fbfc'],
  [/(ice|packed_ice|blue_ice)/, '#7dafe8'],
  [/(water)/, '#3f5fb8'],
  [/(lava|magma)/, '#d45a12'],

  [/(glass|glass_pane)/, '#a8d5e8'],
  [/(leaves)/, '#4a7a2a'],
  [/(sea_lantern|glowstone|shroomlight)/, '#e8d99a'],
  [/(iron_block|iron_bars)/, '#d8d8d8'],
  [/(gold_block)/, '#f6d34a'],
  [/(diamond_block)/, '#6de3da'],
  [/(emerald_block)/, '#41d16a'],
  [/(copper|cut_copper|waxed)/, '#c1704a'],
  [/(netherite)/, '#40383b'],
  [/(amethyst)/, '#9a6fc4'],
  [/(concrete_powder)/, '#b0a68f'],
  [/(wool|carpet)/, '#d6d6d6'],
  [/(planks|log|wood|stripped)/, '#9c7f4e'],
]

/** What a voxel is drawn as when its cell never recorded a material. */
export const UNKNOWN_COLOUR = '#7f8a72'

/**
 * The colour for a block name.
 *
 * Cached, because the hot path asks for the same few dozen names tens of thousands of times per
 * frame and a regular expression sweep per voxel would be most of the drawing.
 */
const cache = new Map<string, string>()

export function blockColour(name: string): string {
  if (!name) return UNKNOWN_COLOUR

  const known = cache.get(name)
  if (known !== undefined) return known

  const colour = FAMILIES.find(([pattern]) => pattern.test(name))?.[1] ?? derived(name)
  cache.set(name, colour)
  return colour
}

/**
 * A colour for a block nothing in the table matched.
 *
 * Muted on purpose: an unlisted block should be visible as *something else* without claiming to be
 * accurate, and a table of vivid unknowns would read as a deliberately colourful building. Stable
 * for a given name, so the same block is the same colour in every schematic and between reloads.
 */
function derived(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0
  }

  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 18% 52%)`
}

/** Resolves a whole palette at once, so the draw loop indexes an array instead of a map. */
export function palette(names: string[]): string[] {
  return names.map(blockColour)
}

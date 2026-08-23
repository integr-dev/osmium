import { BLOCK_NAMES, BLOCK_NAMES_VERSION } from './blockNames.generated'

/**
 * Block names an operator can read, and searching over them.
 *
 * `minecraft:white_terracotta` is what the file says and what the host is told; **White Terracotta**
 * is what a person is choosing between. Both matter, so both are shown — the readable one to pick
 * by, the id underneath because it is what actually gets sent.
 *
 * The table is generated and committed — see `scripts/generate-block-names.mjs`. It lags the game
 * by a version or two, which is why **nothing here treats an unknown block as an error**: a
 * schematic can legitimately contain a block no dataset has heard of, and the honest response is to
 * show it prettified rather than to refuse it.
 */

export { BLOCK_NAMES_VERSION }

/** Strips the namespace. Everything else in Minecraft is `minecraft:`, and the prefix is noise. */
export function blockId(name: string): string {
  return name.replace(/^minecraft:/, '')
}

/**
 * Title Case from a raw id, for blocks the table has never heard of.
 *
 * Not a guess at the real name — it is the id, made readable. `crimson_hyphae` becomes
 * `Crimson Hyphae`, which is what Mojang would have called it anyway, and when it is wrong it is
 * wrong in a way that still identifies the block.
 */
function prettify(id: string): string {
  return id
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** What to call a block. Falls back through the id rather than ever returning nothing. */
export function blockName(name: string): string {
  const id = blockId(name)
  return BLOCK_NAMES[id] ?? prettify(id)
}

/** True when the name came from the table rather than from prettifying the id. */
export function isKnownBlock(name: string): boolean {
  return blockId(name) in BLOCK_NAMES
}

export interface BlockMatch {
  /** The bare id, which is what gets stored and sent. */
  id: string
  name: string
}

/**
 * Blocks matching what has been typed, best first.
 *
 * Ranked rather than filtered, because the useful answer is rarely the alphabetically first one.
 * A query of `stone` should offer **Stone** before **Stone Brick Slab**, and offering them in table
 * order would bury it under a dozen variants.
 *
 * The ranks, in order: the id exactly, then either the id or the name starting with the query, then
 * a word inside the name starting with it, then anything containing it. Word-start beats plain
 * containment so that `brick` surfaces **Brick Stairs** ahead of **Nether Brick**, which is what
 * somebody typing a material rather than a modifier means.
 */
export function searchBlocks(query: string, limit = 12): BlockMatch[] {
  const needle = blockId(query).trim().toLowerCase().replace(/\s+/g, '_')
  const entries = Object.entries(BLOCK_NAMES)

  if (!needle) return entries.slice(0, limit).map(([id, name]) => ({ id, name }))

  const ranked: Array<{ match: BlockMatch; rank: number }> = []

  for (const [id, name] of entries) {
    const lowerName = name.toLowerCase()
    const spaced = needle.replace(/_/g, ' ')

    let rank: number
    if (id === needle) rank = 0
    else if (id.startsWith(needle) || lowerName.startsWith(spaced)) rank = 1
    else if (lowerName.split(' ').some((word) => word.startsWith(spaced))) rank = 2
    else if (id.includes(needle) || lowerName.includes(spaced)) rank = 3
    else continue

    ranked.push({ match: { id, name }, rank })
  }

  // Shorter first within a rank: the plainest block with a given word in it is almost always the
  // one being reached for, and it is also the shortest name.
  ranked.sort((a, b) => a.rank - b.rank || a.match.id.length - b.match.id.length)

  return ranked.slice(0, limit).map((entry) => entry.match)
}

/**
 * Regenerates `src/lib/blockNames.generated.ts` from PrismarineJS `minecraft-data`.
 *
 * Run by hand, not on install:
 *
 *   node scripts/generate-block-names.mjs [version]
 *
 * **A committed table rather than a runtime fetch.** Osmium is deployed behind nginx with a strict
 * CSP and may run somewhere with no route to GitHub at all; a picker that needs the internet to
 * show a block name would be a picker that is empty exactly when somebody is working offline. The
 * table is 40-odd kilobytes, which is smaller than most of the icons already in the bundle.
 *
 * The source is block *data* — names, hardness, drops — rather than Minecraft assets. Its README
 * says MIT while noting the licence "might change to something more appropriate" if one of its
 * sources requires it, and the repository carries no LICENSE file. Only the display names are taken.
 */

const DATA_PATHS = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/dataPaths.json'
const BLOCKS = (path) =>
  `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/${path}/blocks.json`

const OUT = new URL('../src/lib/blockNames.generated.ts', import.meta.url)

async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.json()
}

const wanted = process.argv[2]
const paths = await json(DATA_PATHS)
const versions = Object.keys(paths.pc)

// Newest by default. The dataset lags the game, which is why `blockName` falls back to prettifying
// the id rather than treating an unknown block as an error.
const version = wanted ?? versions[versions.length - 1]
if (!paths.pc[version]) {
  throw new Error(`No data for ${version}. Available: ${versions.slice(-8).join(', ')}`)
}

const blocks = await json(BLOCKS(paths.pc[version].blocks))

const names = Object.fromEntries(
  blocks
    .filter((block) => block.name && block.displayName)
    .map((block) => [block.name, block.displayName])
    .sort(([a], [b]) => a.localeCompare(b)),
)

const body = `/**
 * Block display names, generated. **Do not edit.**
 *
 * From PrismarineJS \`minecraft-data\`, Minecraft ${version}. Regenerate with:
 *
 *     node scripts/generate-block-names.mjs [version]
 *
 * Committed rather than fetched so the picker works with no route to the internet, and so a strict
 * CSP needs no exception. Names only — none of Minecraft's own assets are here.
 */

/** The Minecraft version these names came from, so the interface can admit what it is working off. */
export const BLOCK_NAMES_VERSION = '${version}'

export const BLOCK_NAMES: Record<string, string> = ${JSON.stringify(names, null, 2)}
`

await (await import('node:fs/promises')).writeFile(OUT, body, 'utf8')
console.log(`${Object.keys(names).length} block names from ${version} -> ${OUT.pathname}`)

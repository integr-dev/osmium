/**
 * Stages the assets prismarine-viewer's renderer fetches at runtime into `public/viewer/`.
 *
 * The renderer asks for `textures/<version>.png` and `blocksStates/<version>.json` by bare relative
 * path, resolved against the page - so they have to be real files under the site root rather than
 * anything the bundler can see. Its meshing worker is loaded the same way.
 *
 * Upstream ships those files prebuilt, but only for the versions in its own `supportedVersions`,
 * which stops at 1.21.4. Anything newer is generated here from `minecraft-assets`, which does carry
 * it. Generated rather than committed: the pair is ~14 MB per version.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(here, '../public/viewer')

/**
 * The versions the viewer can render.
 *
 * One entry per *major* is enough: prismarine-viewer resolves an unknown patch to the newest one it
 * holds of the same major, so `1.21.9` finds `1.21.4`. A major with no entry at all resolves to
 * nothing and the viewer refuses to start, which is why the list is explicit rather than inferred -
 * a fleet on a major nobody staged should fail loudly at build time, not per browser.
 */
const VERSIONS = (process.env['OSMIUM_VIEWER_VERSIONS'] ?? '1.21.4,26.1').split(',').map((v) => v.trim())

/** Entities are rendered at a fixed version upstream, so only that one's textures are needed. */
const ENTITY_VERSION = '1.16.4'

const force = process.argv.includes('--force')
const viewerRoot = path.dirname(require.resolve('prismarine-viewer/package.json'))
const shipped = path.join(viewerRoot, 'public')

/**
 * Versions the renderer reads regardless of what is being rendered.
 *
 * `viewer/lib/models.js` opens with `require('minecraft-data')('1.16.2').tints` - the colours for
 * grass, foliage and water come from that release and no other, whatever version the world is. Leave
 * it out and every tinted block fails its biome lookup in the mesher, which is most of a landscape.
 *
 * Read out of upstream's source rather than written down here, so the filter and the check that
 * guards it cannot agree with each other while both being wrong - and so a version upstream changes
 * is followed rather than quietly dropped.
 */
const RENDERER_VERSIONS = versionsHardcodedInRenderer()

function versionsHardcodedInRenderer() {
  const lib = path.join(viewerRoot, 'viewer', 'lib')
  const pattern = /require\(['"]minecraft-data['"]\)\(['"]([^'"]+)['"]\)/g
  const found = new Set()

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        for (const [, version] of readFileSync(full, 'utf8').matchAll(pattern)) found.add(version)
      }
    }
  }

  walk(lib)
  return [...found]
}


function staged(...parts) {
  return path.join(out, ...parts)
}

/** Skips work that is already done, so an incremental build does not redo ~14 MB per version. */
function needed(target) {
  return force || !existsSync(target)
}

function copy(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

/**
 * Rebuilds the meshing worker, rather than copying the one upstream ships.
 *
 * The shipped bundle has `minecraft-data` baked into it as of upstream's own release, so it knows
 * nothing about any version published since - and the failure is not a missing texture but a hard
 * `Do not have data for <version>` thrown inside the worker, four times, with the screen left
 * blank. Built here against the `minecraft-data` this project actually resolves.
 *
 * esbuild rather than upstream's webpack: the inputs are the same three accommodations either way -
 * Node globals injected, `global` pointed at `globalThis`, and everything in `minecraft-data` that
 * meshing does not read left out - and this is a bundler the project can carry as one devDependency.
 */
async function stageWorker() {
  if (!needed(staged('worker.js'))) return

  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [path.join(viewerRoot, 'viewer', 'lib', 'worker.js')],
    outfile: staged('worker.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    inject: [path.resolve(here, 'viewer-worker-shims.js')],
    // `global` because the worker reads it to decide whether it is in Node; the module paths
    // because `minecraft-data` builds file paths from them at import time even when every file it
    // would load is already bundled. Empty strings are enough - nothing reads the path back, it
    // just has to exist.
    define: { global: 'globalThis', __dirname: '""', __filename: '""' },
    // `util` and `assert` have faithful browser implementations; `zlib` does not, and does not need
    // one - chunks reach the renderer as JSON that the page has already inflated, so the compression
    // path is never taken. Upstream stubs it the same way.
    alias: { util: 'util/', assert: 'assert/' },
    plugins: [onlyMeshingData(), stub('zlib'), upstreamPatches()],
    logLevel: 'error',
  })
  console.log('viewer-assets: built worker.js')
  await verifyMeshingData(esbuild)
  verifyWorker()
}

/**
 * Proves the filter left behind everything the mesher reads by name.
 *
 * Starting the worker is not enough: it comes up happily and only fails once a section is meshed,
 * per biome, inside a Web Worker. What it needs is reached through hardcoded version strings -
 * `models.js` takes its tints from 1.16.2 whatever the world is - so the way to catch a version
 * dropped from the bundle is to look them up through the same filter and see if they are there.
 */
async function verifyMeshingData(esbuild) {
  const probe = `
    const mcData = require('minecraft-data')
    const missing = []
    for (const version of ${JSON.stringify([...VERSIONS, ...RENDERER_VERSIONS])}) {
      const data = mcData(version)
      if (!data) { missing.push(version + ': no data'); continue }
      for (const field of ['blocks', 'biomes', 'tints']) {
        if (!data[field] || Object.keys(data[field]).length === 0) missing.push(version + '.' + field)
      }
    }
    if (missing.length) { console.error('missing: ' + missing.join(', ')); process.exit(1) }
  `

  // Written out rather than piped: bundling this pulls in the data itself, and a few megabytes of
  // source is far past what a command line will carry.
  const script = staged('.probe.cjs')
  await esbuild.build({
    stdin: { contents: probe, resolveDir: here, loader: 'js' },
    outfile: script,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    plugins: [onlyMeshingData()],
    logLevel: 'error',
  })

  const { status, stderr } = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  rmSync(script, { force: true })

  if (status !== 0) {
    throw new Error(`viewer-assets: the data filter dropped something the mesher reads:\n${(stderr ?? '').trim()}`)
  }
  console.log('viewer-assets: blocks, biomes and tints survive the filter')
}

/**
 * Starts the worker once, here, rather than letting a browser be the first to try.
 *
 * Everything this bundle gets wrong goes wrong at import or on the first message, inside a Web
 * Worker, where it surfaces as `Uncaught` lines in a console with no stack into this project and a
 * viewer that renders nothing. A worker that cannot mesh is a broken build, so it fails the build.
 *
 * A separate process because loading it defines globals and never lets the event loop go idle.
 */
function verifyWorker() {
  const check = `
    globalThis.self = {}
    globalThis.postMessage = () => {}
    globalThis.performance = require('perf_hooks').performance
    require(${JSON.stringify(staged('worker.js'))})
    if (typeof globalThis.self.onmessage !== 'function') throw new Error('worker installed no message handler')
    for (const version of ${JSON.stringify(VERSIONS)}) globalThis.self.onmessage({ data: { type: 'version', version } })
    process.exit(0)
  `

  const { status, stderr } = spawnSync(process.execPath, ['--input-type=commonjs', '-e', check], { encoding: 'utf8' })
  if (status === 0) {
    console.log(`viewer-assets: worker starts and accepts ${VERSIONS.join(', ')}`)
    return
  }

  throw new Error(`viewer-assets: the worker it just built cannot run:\n${stderr.trim()}`)
}

/**
 * Every folder the given versions actually read from.
 *
 * A version's data is emphatically *not* all under a folder of its own name: `minecraft-data` points
 * each file at whichever release last changed it, so 26.1 draws its biomes and tints from `pc/1.20`
 * and `pc/1.16.1`. Keeping only the folders named after the versions served therefore strips most
 * of what they need - and it does so quietly, surfacing much later as an undefined biome lookup in
 * the mesher and chunks that never appear.
 *
 * `common` is added because it is shared by everything and named after nothing.
 */
function foldersBehind(versions) {
  const paths = require('minecraft-data/minecraft-data/data/dataPaths.json')
  const folders = new Set(['common'])

  for (const edition of Object.values(paths)) {
    for (const version of versions) {
      for (const location of Object.values(edition[version] ?? {})) {
        // `pc/1.20` - the folder is the last segment.
        folders.add(location.split('/').at(-1))
      }
    }
  }

  return folders
}

/**
 * What meshing actually reads out of `minecraft-data`.
 *
 * Upstream's list, and the reason the worker is tens of megabytes rather than hundreds: the package
 * carries every protocol, recipe and entity definition for every version, and a worker that turns
 * block states into geometry needs almost none of it. Anything else resolves to nothing.
 */
function onlyMeshingData() {
  const wanted = new Set([
    'blocks', 'blockCollisionShapes', 'tints', 'blockStates',
    'biomes', 'features', 'version', 'legacy', 'versions', 'protocolVersions',
    // How a version finds any of the above. Without it nothing resolves to a folder at all.
    'dataPaths',
  ])

  // Everything under `data/<edition>/<version>/`. Only the versions actually served are kept: the
  // package carries a hundred of them, and the renderer is only ever handed one this build staged.
  const versioned = /[\\/]data[\\/][^\\/]+[\\/]([^\\/]+)[\\/][^\\/]+\.json$/

  /**
   * An empty *array*, not an empty object.
   *
   * `minecraft-data` indexes most of these by folding over them, so a left-out file has to be
   * something that can still be folded - `{}` reaches the browser as
   * `t.reduce is not a function`, thrown while the worker is still starting, and nothing is ever
   * meshed. An array answers both shapes: indexing yields an empty index, and a property lookup
   * yields undefined rather than throwing.
   */
  const EMPTY = '[]'

  const KEPT = foldersBehind([...VERSIONS, ...RENDERER_VERSIONS])

  return {
    name: 'osmium:only-meshing-data',
    setup(build) {
      build.onLoad({ filter: /minecraft-data[\\/].*\.json$/ }, ({ path: file }) => {
        const name = path.basename(file, '.json')
        if (!wanted.has(name)) return { contents: EMPTY, loader: 'json' }

        // An index rather than a version's own data - `versions`, `dataPaths` and the like, which
        // are how a version is looked up at all.
        const version = versioned.exec(file)?.[1]
        if (version === undefined) return undefined

        return KEPT.has(version) ? undefined : { contents: EMPTY, loader: 'json' }
      })
    },
  }
}

/**
 * Teaches the worker that a world can start below zero.
 *
 * It decides whether a section exists with `chunk.sections[Math.floor(y / 16)]`, which reads the
 * array as though index 0 were y=0. Since 1.18 index 0 is the section at `chunk.minY`, so the index
 * is short by `minY / 16` - harmless for y at or above zero, because every section is allocated and
 * some section is always found, but `undefined` for anything below it. A section that answers
 * `undefined` is not queued and never retried, so the bottom of every modern world is invisible:
 * in the Overworld that is everything under bedrock level.
 *
 * A patch to a dependency's source, which is not free, and the alternatives are worse: the check is
 * inside a Web Worker two callers deep, so there is nothing to wrap from outside, and vendoring the
 * whole file to change one expression would mean owning the rest of it too. The build fails if the
 * expression is not found, so this cannot rot into a silent no-op.
 */
function upstreamPatches() {
  /**
   * Three edits to upstream's mesher, each for a bug that renders as missing world.
   *
   * The first two are independent assumptions that a world starts at y=0, in two files.
   *
   * `worker.js` decides whether a section exists by reading the array as though index 0 were y=0.
   * Since 1.18 index 0 is the section at `chunk.minY`, so below zero the lookup is `undefined`, the
   * section is never queued, and nothing down there is ever meshed.
   *
   * `models.js` then culls any face whose neighbour lies below y=0 - which used to mean "facing the
   * void beneath the world" and now means "facing ordinary ground". With it, every cullable face of
   * every full block below zero is discarded, so the only things left visible are the ones whose
   * faces are not cullable at all: grass, azalea, the odd bush. Removed outright rather than made
   * `minY`-aware, because what it now protects against is a face at the true bottom of the world
   * that no camera can reach.
   *
   * The third is a substring test standing in for an equality test. `getModelVariants` opens by
   * refusing to model air, and asks `block.name.includes('air')` - which is true of every block in
   * the game whose name ends in **st-air-s**. Every staircase is therefore treated as air and given
   * no model at all, so none has ever been drawn. Narrowed to the three blocks that are actually
   * air; `missing_texture` is deliberately not among them, since that one has a model and is the
   * whole point of the fallback beneath it.
   */
  const edits = [
    {
      file: path.join(viewerRoot, 'viewer', 'lib', 'worker.js'),
      from: 'chunk.sections[Math.floor(y / 16)]',
      to: 'chunk.sections[Math.floor((y - (chunk.minY ?? 0)) / 16)]',
      expected: 2,
    },
    {
      file: path.join(viewerRoot, 'viewer', 'lib', 'models.js'),
      from: 'if (neighbor.position.y < 0) continue',
      to: '/* osmium: a world may start below zero */',
      expected: 2,
    },
    {
      file: path.join(viewerRoot, 'viewer', 'lib', 'models.js'),
      from: "if (block.name.includes('air')) return []",
      to: "if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return []",
      expected: 1,
    },
  ]

  return {
    name: 'osmium:upstream-patches',
    setup(build) {
      build.onLoad({ filter: /viewer[\\/]lib[\\/](worker|models)\.js$/ }, ({ path: file }) => {
        // More than one edit may land in the same file, so they are all applied in turn rather
        // than the first one winning.
        const mine = edits.filter((candidate) => path.resolve(candidate.file) === path.resolve(file))
        if (mine.length === 0) return undefined

        let contents = readFileSync(file, 'utf8')
        for (const edit of mine) {
          const found = contents.split(edit.from).length - 1
          if (found !== edit.expected) {
            throw new Error(
              `viewer-assets: expected ${edit.expected} occurrences of "${edit.from}" in ` +
                `${path.basename(file)}, found ${found}. Upstream has changed; re-read it before ` +
                'assuming this patch is still right.',
            )
          }
          contents = contents.split(edit.from).join(edit.to)
        }

        return { contents, loader: 'js' }
      })
    },
  }
}

/** Resolves a Node builtin to nothing, for one the browser has no use for. */
function stub(builtin) {
  return {
    name: `osmium:stub-${builtin}`,
    setup(build) {
      build.onResolve({ filter: new RegExp(`^(node:)?${builtin}$`) }, () => ({ path: builtin, namespace: 'stub' }))
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {}', loader: 'js' }))
    },
  }
}

function stageEntityTextures() {
  const target = staged('textures', ENTITY_VERSION, 'entity')
  if (!needed(target)) return
  copy(path.join(shipped, 'textures', ENTITY_VERSION, 'entity'), target)
  console.log(`viewer-assets: staged ${ENTITY_VERSION} entity textures`)
}

function stageVersion(version) {
  const atlas = staged('textures', `${version}.png`)
  const states = staged('blocksStates', `${version}.json`)
  if (!needed(atlas) && !needed(states)) return

  const prebuilt = path.join(shipped, 'textures', `${version}.png`)
  if (existsSync(prebuilt)) {
    copy(prebuilt, atlas)
    copy(path.join(shipped, 'blocksStates', `${version}.json`), states)
    console.log(`viewer-assets: copied prebuilt ${version}`)
  } else {
    generate(version, atlas, states)
  }

  // After both paths, because a prebuilt state file needs it exactly as much as a generated one.
  boxBlockEntities(version, states)
}

/**
 * Blocks the renderer would otherwise draw as nothing at all.
 *
 * A chest and a shulker box are **block entities**: Minecraft draws them with a dedicated entity
 * renderer from `entity/chest/*`, and their block model file is deliberately empty - a particle
 * texture and no geometry. A mesher builds from model elements, so it emits nothing for them, and a
 * wall of chests renders as thin air. That is upstream's shape, not a bug in it; rendering them
 * properly means implementing a second renderer.
 *
 * So they are given a box of their own particle texture, at roughly the size the real thing
 * occupies. A shulker box *is* a full cube, so that one is nearly exact; a chest is inset by a pixel
 * either side and comes out a shade large and plank-coloured. Both are the right size, in the right
 * place, and visible, which is the whole difference that matters when the point of the screen is
 * seeing what is around an agent.
 *
 * **Only the ones a box describes.** Beds, signs, banners, conduits and decorated pots are block
 * entities too and are left alone: a solid block where a flat wall sign should be reads as a wall
 * somebody cannot walk through, which is worse than the gap it replaces.
 */
function boxBlockEntities(version, target) {
  const states = JSON.parse(readFileSync(target, 'utf8'))
  let boxed = 0

  for (const [name, block] of Object.entries(states)) {
    const box = boxOf(name)
    if (!box) continue

    for (const variant of Object.values(block?.variants ?? {})) {
      for (const entry of Array.isArray(variant) ? variant : [variant]) {
        const model = entry?.model
        // Skip anything that already has geometry: a version where upstream has solved this
        // properly must not be given a box on top of it.
        if (!model || (model.elements ?? []).length) continue

        const texture = model.textures?.particle
        if (!texture) continue

        model.elements = [
          {
            from: box[0],
            to: box[1],
            shade: true,
            // No `cullface`. A chest does not fill its cell, so letting a neighbour cull the face
            // between them would open a hole straight through it.
            faces: Object.fromEntries(
              ['down', 'up', 'north', 'south', 'west', 'east'].map((side) => [side, { texture }]),
            ),
          },
        ]
        boxed++
      }
    }
  }

  if (!boxed) throw new Error(`viewer-assets: ${version} has no chests or shulker boxes to draw`)

  writeFileSync(target, JSON.stringify(states))
  console.log(`viewer-assets: boxed ${boxed} block entities for ${version}`)
}

/**
 * The box that stands in for one block entity, or null for one no box describes.
 *
 * Heads and skulls are here as well as the storage blocks, because they are cube-shaped: a head is
 * an eighth of a block, sitting on the floor. **Their colour is the one thing this gets wrong** -
 * the only texture a skull model declares is its particle, which is `soul_sand`, because what
 * vanilla actually draws is an entity texture and for a player head that texture is a skin fetched
 * per player. So a head comes out a soul-sand-coloured cube of the right size in the right cell.
 * That is the whole choice on offer: a wrong colour, or nothing there at all.
 *
 * A wall head is centred in its cell rather than sat on the floor. Which way it faces is not in the
 * block states at all - vanilla leaves skull rotation entirely to the block entity, so there is a
 * single variant with no rotation on it - and the middle of the cell is the reading that is never
 * badly wrong for any of the four facings.
 *
 * `piston_head` ends in `_head` and is not one of these. It has real geometry, and the caller
 * skips anything that does.
 */
function boxOf(name) {
  if (name.includes('chest') || name.endsWith('shulker_box')) return [[0, 0, 0], [16, 16, 16]]

  if (name.endsWith('_skull') || name.endsWith('_head')) {
    return name.includes('_wall_') ? [[4, 4, 4], [12, 12, 12]] : [[4, 0, 4], [12, 8, 12]]
  }

  return null
}

/**
 * Builds what upstream's `prerender.js` would have, for a version it does not know.
 *
 * Two deviations, both deliberate. The atlas is blitted with `pngjs` rather than `canvas`, so the
 * frontend build gains no native dependency for a once-per-version step - the output is a plain
 * grid of 16x16 tiles either way. And model texture references are flattened first: see below.
 */
function generate(version, atlasTarget, statesTarget) {
  const mcAssets = require('minecraft-assets')
  const { prepareBlocksStates } = require('prismarine-viewer/viewer/lib/modelsBuilder')

  const assets = mcAssets(version)
  if (!assets) {
    throw new Error(
      `viewer-assets: minecraft-assets has no data for ${version}. Upgrade it, or drop the ` +
        'version from OSMIUM_VIEWER_VERSIONS.',
    )
  }

  flattenTextureRefs(assets)
  const atlas = buildAtlas(assets)

  mkdirSync(path.dirname(atlasTarget), { recursive: true })
  writeFileSync(atlasTarget, atlas.image)

  mkdirSync(path.dirname(statesTarget), { recursive: true })
  writeFileSync(statesTarget, JSON.stringify(prepareBlocksStates(assets, atlas)))
  console.log(`viewer-assets: generated ${version}`)
}

/**
 * 26.1 replaced a model's plain texture references with objects - `{ sprite, force_translucent }`
 * where a string used to be. `prepareModel` walks those references expecting to be able to call
 * `charAt` on them, so it throws on the first pane of stained glass.
 *
 * Flattened to the sprite name here, at generation time, which is the only place the difference is
 * visible: what the renderer loads is the resolved UV rectangle either way. The translucency hint
 * is dropped with the wrapper - glass renders as the alpha in its texture, which is what every
 * version before this one did.
 */
function flattenTextureRefs(assets) {
  for (const model of Object.values(assets.blocksModels)) {
    if (!model?.textures) continue
    for (const [key, value] of Object.entries(model.textures)) {
      if (typeof value === 'object' && value !== null && typeof value.sprite === 'string') {
        model.textures[key] = value.sprite
      }
    }
  }
}

const TILE = 16

/** Ports `prismarine-viewer/viewer/lib/atlas.js` off `canvas`. Same grid, same UV maths. */
function buildAtlas(assets) {
  const { PNG } = require('pngjs')

  const blocks = path.join(assets.directory, 'blocks')
  const files = readdirSync(blocks).filter((file) => file.endsWith('.png'))
  // Index 0 is what an unresolved block falls back to, so it has to be present before the real ones.
  files.unshift('missing_texture.png')
  const missing = path.join(viewerRoot, 'viewer', 'lib', 'missing_texture.png')

  const across = nextPowerOfTwo(Math.ceil(Math.sqrt(files.length)))
  const size = across * TILE
  const sheet = new PNG({ width: size, height: size })
  const textures = {}

  files.forEach((file, index) => {
    const x = (index % across) * TILE
    const y = Math.floor(index / across) * TILE
    textures[file.split('.')[0]] = { u: x / size, v: y / size, su: TILE / size, sv: TILE / size }

    const source = PNG.sync.read(readFileSync(index === 0 ? missing : path.join(blocks, file)))
    // Animated textures are a vertical strip of frames; upstream takes the first, so do the same.
    blit(source, sheet, x, y)
  })

  return { image: PNG.sync.write(sheet), json: { size: TILE / size, textures } }
}

function blit(source, sheet, atX, atY) {
  const width = Math.min(TILE, source.width)
  const height = Math.min(TILE, source.height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (source.width * y + x) << 2
      const to = (sheet.width * (atY + y) + (atX + x)) << 2
      source.data.copy(sheet.data, to, from, from + 4)
    }
  }
}


/**
 * The one colour each block reads as, seen from above, for the top-down map.
 *
 * Derived from what the renderer already draws rather than from a table: for every block, the top
 * face's texture is looked up in the atlas this build just wrote, and its pixels averaged. That
 * means a block added in a future version gets a colour the day `minecraft-assets` carries it, and
 * that the map and the 3D view can never disagree about what something looks like.
 *
 * Averaged with alpha as the weight, so the transparent margin around a sapling or a pane of glass
 * does not wash it out towards black.
 *
 * Blocks that resolve to nothing are left out on purpose, and that absence is the map's rule for
 * what counts as a surface: air, cave air, void air, light and barrier all carry no model, so the
 * host walking down a column steps straight past them without needing a list of what to skip.
 */
function stageMapColours(version) {
  const target = staged('mapColours', `${version}.json`)
  if (!needed(target)) return

  const { PNG } = require('pngjs')
  const atlas = PNG.sync.read(readFileSync(staged('textures', `${version}.png`)))
  const states = JSON.parse(readFileSync(staged('blocksStates', `${version}.json`), 'utf8'))
  const tints = tintsAt(TINT_VERSION, MAP_BIOME)

  const colours = {}
  let modelled = 0
  for (const [name, block] of Object.entries(states)) {
    const faces = facesOf(block)
    if (faces.length) modelled++
    for (const face of faces) {
      const averaged = averageOf(atlas, face.texture)
      if (!averaged) continue
      colours[name] = hex(tint(averaged, name, face.tintindex, tints))
      break
    }
  }

  verifyMapColours(colours, modelled)

  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(colours))
  console.log(`viewer-assets: coloured ${Object.keys(colours).length} blocks for ${version}`)
}

/**
 * The biome the map is coloured as if everything were in it.
 *
 * Grass, foliage and water are greyscale textures multiplied by a biome tint at draw time, so
 * without one they come out the colour of wet cement. The map has no biome to work from - the host
 * sends which block is on top, not what is around it - so one stands in for all of them. Plains is
 * the middle of the range rather than an extreme of it: swamp green and badlands orange both read
 * as broken when they turn up somewhere they do not belong.
 */
const MAP_BIOME = 'plains'

/**
 * The release the tint tables are read from, which is not the version being staged.
 *
 * From 1.20 on, `minecraft-data` reports the grass and foliage tint of an ordinary biome as `0` -
 * a sentinel meaning *derive it from the biome's temperature and rainfall through the colormap*,
 * not the colour black. Taken at face value it multiplies every plant on the map down to nothing,
 * which is exactly what it did here first time round.
 *
 * The mesher has the same problem and answers it by pinning one release that still carries real
 * numbers, so the map reads from whichever release that is. Pinning it twice, independently, is how
 * the map and the 3D view would come to disagree about the colour of grass.
 */
const TINT_VERSION = versionOfTintsInRenderer()

/** The release named on `viewer/lib/models.js`'s `tints` line. Throws if that line is gone. */
function versionOfTintsInRenderer() {
  const source = readFileSync(path.join(viewerRoot, 'viewer', 'lib', 'models.js'), 'utf8')
  const match = source.match(/require\(['"]minecraft-data['"]\)\(['"]([^'"]+)['"]\)\.tints/)
  if (!match) {
    throw new Error(
      'viewer-assets: models.js no longer reads its tints from a fixed release. Find where the ' +
        'mesher gets them now and point the map at the same place, or the two will disagree.',
    )
  }
  return match[1]
}

/** The tint tables for one biome, flattened to `{ grass, foliage, water, redstone, constant }`. */
function tintsAt(version, biome) {
  const tables = require('minecraft-data')(version)?.tints
  if (!tables) throw new Error(`viewer-assets: minecraft-data has no tints for ${version}`)

  // Listed biome first, then the table's own fallback - the same order the mesher resolves in,
  // where an unlisted biome reaches `default` through a Proxy. Most biomes are unlisted on purpose:
  // vanilla's plain blue water is the default, and the table only names the five that differ.
  const pick = (table, key) => {
    const entry = table.data.find((row) => row.keys.includes(key))
    const colour = entry ? entry.color : table.default
    return colour === undefined ? null : colour & 0xffffff
  }

  const constant = {}
  for (const row of tables.constant.data) for (const key of row.keys) constant[key] = row.color & 0xffffff

  const biomes = {}
  for (const key of ['grass', 'foliage', 'water']) {
    const colour = pick(tables[key], biome)
    // Zero is the colormap sentinel, not black. See TINT_VERSION.
    if (!colour) throw new Error(`viewer-assets: ${version} has no usable ${key} tint for ${biome}`)
    biomes[key] = colour
  }

  // Full power, which is the colour redstone dust is drawn as when it is carrying a signal. A map
  // showing every wire dark is showing the less useful of the two states.
  return { ...biomes, constant, redstone: pick(tables.redstone, '15') ?? 0xff0000 }
}

/**
 * What a map might see of a block, best first: up faces from the top down, then everything else,
 * then the particle texture.
 *
 * A list rather than one face, because the obvious answer is often blank. The up face of a door or
 * a trapdoor is a three-pixel sliver that samples empty space in the texture, and a chain's is
 * empty outright - taking it and stopping left thirty-odd real blocks with no colour at all. So the
 * caller walks the list and keeps the first face that has any pixels in it.
 *
 * The tail covers two shapes with no up face to find. A cross model - grass, flowers, saplings - is
 * two crossed quads and nothing else. A fluid has no faces whatsoever, because the mesher builds
 * water and lava from its own geometry rather than from the model; those still name a particle
 * texture, and water's is `water_still`, which is exactly the one wanted.
 */
function facesOf(block) {
  const first = Object.values(block?.variants ?? {})[0]
  const model = (Array.isArray(first) ? first[0] : first)?.model
  if (!model) return []

  const up = []
  const rest = []
  for (const element of model.elements ?? []) {
    for (const [side, face] of Object.entries(element.faces ?? {})) {
      if (!face?.texture) continue
      if (side === 'up') up.push({ face, top: element.to?.[1] ?? 0 })
      else rest.push(face)
    }
  }

  up.sort((a, b) => b.top - a.top)
  const found = [...up.map((entry) => entry.face), ...rest]
  if (found.length) return found
  return model.textures?.particle ? [{ texture: model.textures.particle }] : []
}

/**
 * The average colour of one atlas tile, weighted by alpha, or null if the tile is fully transparent.
 *
 * The UV rectangle is the same one the renderer samples, so this reads the very pixels that end up
 * on the block - including the first frame of an animated texture, which is all the atlas holds.
 */
function averageOf(atlas, uv) {
  const x0 = Math.round(uv.u * atlas.width)
  const y0 = Math.round(uv.v * atlas.height)
  const width = Math.round(uv.su * atlas.width)
  const height = Math.round(uv.sv * atlas.height)

  let r = 0
  let g = 0
  let b = 0
  let weight = 0
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      const at = (atlas.width * y + x) << 2
      const alpha = atlas.data[at + 3] / 255
      if (!alpha) continue
      r += atlas.data[at] * alpha
      g += atlas.data[at + 1] * alpha
      b += atlas.data[at + 2] * alpha
      weight += alpha
    }
  }

  return weight ? [r / weight, g / weight, b / weight] : null
}

/**
 * Applies the biome tint a face asks for, by the same rules the mesher uses.
 *
 * Mirrors `viewer/lib/models.js`: tint index 0 means grass unless the block is one of the handful
 * that overrides it. Water is the one addition - it is a fluid, so it has no face to carry a tint
 * index, and its texture is the same near-white grey grass has.
 */
function tint(rgb, name, index, tints) {
  const table =
    name === 'water' ? tints.water
      : index === undefined ? null
        : name === 'redstone_wire' ? tints.redstone
          : tints.constant[name] !== undefined ? tints.constant[name]
            : name.includes('leaves') || name === 'vine' ? tints.foliage
              : tints.grass

  if (table === null) return rgb
  return [
    (rgb[0] * ((table >> 16) & 0xff)) / 255,
    (rgb[1] * ((table >> 8) & 0xff)) / 255,
    (rgb[2] * (table & 0xff)) / 255,
  ]
}

function hex(rgb) {
  return rgb.map((channel) => Math.round(Math.min(255, channel)).toString(16).padStart(2, '0')).join('')
}

/**
 * What the table has to get right for the map to be readable at a glance.
 *
 * Not a spot check of exact values - a texture change upstream would break those and change nothing
 * that matters. These are the relations a person reads the map by: grass is green, water is blue,
 * stone is grey, wood is warm. Each also proves a different part of the path above: grass and water
 * prove the biome tints are applied at all, stone proves an ordinary top face resolves, and planks
 * prove a block whose top and side differ is not being read off its side.
 */
function verifyMapColours(colours, modelled) {
  const rgb = (name) => {
    const value = colours[name]
    if (!value) throw new Error(`viewer-assets: no map colour for ${name}`)
    return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16))
  }

  const [gr, gg, gb] = rgb('grass_block')
  if (gg <= gr || gg <= gb) throw new Error(`viewer-assets: grass_block is not green (#${colours['grass_block']})`)

  const [wr, wg, wb] = rgb('water')
  if (wb <= wr || wb <= wg) throw new Error(`viewer-assets: water is not blue (#${colours['water']})`)

  const stone = rgb('stone')
  if (Math.max(...stone) - Math.min(...stone) > 24) {
    throw new Error(`viewer-assets: stone is not grey (#${colours['stone']})`)
  }

  const [pr, pg, pb] = rgb('oak_planks')
  if (!(pr > pg && pg > pb)) throw new Error(`viewer-assets: oak_planks is not warm (#${colours['oak_planks']})`)

  // A block with a model but no colour is a hole in the map, and it would look like terrain that
  // had not loaded rather than like a bug. Every block that resolves to a face has to resolve to a
  // colour, so this is exact rather than a ratio.
  const coloured = Object.keys(colours).length
  if (coloured !== modelled) {
    throw new Error(`viewer-assets: ${modelled - coloured} of ${modelled} modelled blocks got no colour`)
  }
}

/**
 * A sprite sheet of every item's icon, for drawing an agent's inventory.
 *
 * Two sources, because Minecraft has two kinds of item. Something you hold - a pickaxe, a carrot -
 * has a flat sprite of its own under `items/`. Something you place has none: the game draws its
 * icon by rendering the block, so what stands in for it here is the same face the map reads, copied
 * out of the block atlas this build just wrote and tinted the same way. A cube drawn in perspective
 * would be closer to the game, and is a renderer this project has no reason to own.
 *
 * One sheet rather than a file per item: an inventory is forty squares, and forty requests for two
 * hundred bytes each is forty round trips to draw one card.
 */
function stageItemIcons(version) {
  const target = staged('itemIcons', `${version}.png`)
  const index = staged('itemIcons', `${version}.json`)
  if (!needed(target) && !needed(index)) return

  const { PNG } = require('pngjs')
  const assets = require('minecraft-assets')(version)
  const data = require('minecraft-data')(version)
  if (!assets || !data) throw new Error(`viewer-assets: no item data for ${version}`)

  const atlas = PNG.sync.read(readFileSync(staged('textures', `${version}.png`)))
  const states = JSON.parse(readFileSync(staged('blocksStates', `${version}.json`), 'utf8'))
  const tints = tintsAt(TINT_VERSION, MAP_BIOME)

  const sprites = path.join(assets.directory, 'items')
  const drawn = new Set(readdirSync(sprites).filter((file) => file.endsWith('.png')).map((file) => file.slice(0, -4)))
  const named = texturesOfItems(assets)

  const names = data.itemsArray.map((item) => item.name)
  const across = nextPowerOfTwo(Math.ceil(Math.sqrt(names.length)))
  const size = across * TILE
  const sheet = new PNG({ width: size, height: size })

  const items = {}
  let at = 0
  for (const name of names) {
    const x = (at % across) * TILE
    const y = Math.floor(at / across) * TILE

    if (!draw(name)) {
      // Nothing anywhere: air, and the handful of technical items that exist in the registry and
      // never in anybody's hands. Left out, so a client can tell an icon that has not been
      // generated from one that is a blank square on purpose.
      continue
    }

    /**
     * The item's own sprite, its own block, or whatever texture the assets say it is drawn from.
     *
     * The first two cover almost everything and are the better answers where they apply - an item
     * sprite is the picture the game actually draws, and a block's own model gives grass a green
     * top rather than the dirt its texture reference points at.
     *
     * The third is the catch-all, and it is where a hundred-odd items were being lost: the name of
     * an item is not the name of its texture. An enchanted golden apple is drawn from
     * `items/golden_apple`, a waxed copper block from `block/copper_block`, every stair and slab
     * from the block it is cut out of. `items_textures.json` is the mapping, and a block texture
     * is resolved by handing its name back to the same block lookup - which is how a slab picks up
     * the tint and the face ordering its parent block already gets right.
     */
    function draw(item) {
      if (drawn.has(item)) {
        blit(PNG.sync.read(readFileSync(path.join(sprites, `${item}.png`))), sheet, x, y)
        return true
      }
      if (copyFace(atlas, states[item], item, tints, sheet, x, y)) return true

      const texture = named.get(item)
      if (!texture) return false

      const [kind, ...rest] = texture.split('/')
      const basename = rest.join('/')
      if (kind === 'items' && drawn.has(basename)) {
        blit(PNG.sync.read(readFileSync(path.join(sprites, `${basename}.png`))), sheet, x, y)
        return true
      }

      // A texture named for one face of a block - `composter_side`, `chiseled_bookshelf_top` -
      // still identifies the block, which is what an icon wants.
      const block = basename.replace(/_(top|bottom|side|front|end)$/, '')
      return copyFace(atlas, states[basename] ?? states[block], item, tints, sheet, x, y)
    }

    items[name] = at
    at++
  }

  verifyItemIcons(items, names.length)

  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, PNG.sync.write(sheet))
  writeFileSync(index, JSON.stringify({ across, tile: TILE, items }))
  console.log(`viewer-assets: drew ${Object.keys(items).length} item icons for ${version}`)
}

/**
 * Copies one block's face out of the block atlas, tinted as the mesher would tint it.
 *
 * The same face the map reads, through the same {@link facesOf} - so a block's icon and its pixel
 * on the map are the same colour by construction. The tint matters more here than it looks: without
 * it a stack of grass blocks is a stack of grey squares, because the texture is greyscale and the
 * colour is a biome multiply applied at draw time.
 *
 * **The whole tile, not the face's rectangle.** A face carries the crop the model samples, which
 * for a torch is the two pixels by two its top happens to be - copied as an icon that is four
 * yellow pixels of flame. Snapping back out to the tile the crop sits in recovers the texture
 * itself, which is what an icon is. The map wants the opposite and reads the crop, because there
 * the question is what that face looks like.
 */
function copyFace(atlas, block, name, tints, sheet, atX, atY) {
  for (const face of facesOf(block)) {
    const u = Math.floor((face.texture.u * atlas.width) / TILE) * TILE
    const v = Math.floor((face.texture.v * atlas.height) / TILE) * TILE

    let painted = false
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const from = (atlas.width * (v + y) + (u + x)) << 2
        const alpha = atlas.data[from + 3]
        if (!alpha) continue

        const [r, g, b] = tint(
          [atlas.data[from], atlas.data[from + 1], atlas.data[from + 2]],
          name,
          face.tintindex,
          tints,
        )
        const to = (sheet.width * (atY + y) + (atX + x)) << 2
        sheet.data[to] = Math.round(Math.min(255, r))
        sheet.data[to + 1] = Math.round(Math.min(255, g))
        sheet.data[to + 2] = Math.round(Math.min(255, b))
        sheet.data[to + 3] = alpha
        painted = true
      }
    }

    // A door's up face is a three-pixel sliver of empty texture. Same problem the map has, same
    // answer: keep walking the list until a face has pixels in it.
    if (painted) return true
  }

  return false
}

/**
 * What the sheet has to get right for an inventory to be readable.
 *
 * The count is a floor rather than an exact number, unlike the map's: hundreds of registry entries
 * are technical and have no icon in the game either, so demanding all of them would be demanding
 * something wrong. The three names prove the three paths - a held item off its own sprite, a placed
 * block off the atlas, and a tinted block that would otherwise come out grey.
 */
function verifyItemIcons(items, total) {
  // One per path through `draw`: an item sprite, a block off its own model, a tinted block that
  // would otherwise come out grey, an item drawn from another item's texture, and a block whose
  // texture is named for something else entirely.
  for (const name of ['diamond_pickaxe', 'stone', 'grass_block', 'enchanted_golden_apple', 'waxed_copper_block']) {
    if (items[name] === undefined) throw new Error(`viewer-assets: no item icon for ${name}`)
  }

  // A floor rather than an exact count, and it is about catching a *resolver* regression: this sat
  // at 87% while the mapping below was missing, and the five names above are what say the paths
  // still work. It cannot be total, because `minecraft-assets` lags `minecraft-data` by a release
  // or so - at 1.21.4 it carries no pale oak and no resin at all, which is 27 items no resolver can
  // find a texture for.
  const drawn = Object.keys(items).length
  if (drawn < total * 0.97) {
    throw new Error(`viewer-assets: only ${drawn} of ${total} items got an icon`)
  }
}

/**
 * What texture each item is drawn from, by name.
 *
 * Read out of the assets rather than guessed at from the item's own name, which is what the first
 * cut of this did and what cost it a hundred items. Values look like `minecraft:items/golden_apple`
 * or `minecraft:block/copper_block`; the namespace is dropped, since there is only ever one here.
 */
function texturesOfItems(assets) {
  const listed = JSON.parse(readFileSync(path.join(assets.directory, 'items_textures.json'), 'utf8'))
  return new Map(
    listed
      .filter((entry) => typeof entry?.name === 'string' && typeof entry.texture === 'string')
      .map((entry) => [entry.name, entry.texture.replace(/^minecraft:/, '')]),
  )
}

function nextPowerOfTwo(n) {
  if (n === 0) return 1
  n--
  n |= n >> 1
  n |= n >> 2
  n |= n >> 4
  n |= n >> 8
  n |= n >> 16
  return n + 1
}

mkdirSync(out, { recursive: true })
await stageWorker()
stageEntityTextures()
for (const version of VERSIONS) {
  stageVersion(version)
  stageMapColours(version)
  stageItemIcons(version)
}

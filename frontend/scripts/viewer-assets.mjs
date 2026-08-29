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
    plugins: [onlyMeshingData(), stub('zlib'), sectionsBelowZero()],
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
function sectionsBelowZero() {
  /**
   * Two independent assumptions that a world starts at y=0, in two files.
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
  ]

  return {
    name: 'osmium:sections-below-zero',
    setup(build) {
      build.onLoad({ filter: /viewer[\\/]lib[\\/](worker|models)\.js$/ }, ({ path: file }) => {
        const edit = edits.find((candidate) => path.resolve(candidate.file) === path.resolve(file))
        if (!edit) return undefined

        const source = readFileSync(file, 'utf8')
        const found = source.split(edit.from).length - 1
        if (found !== edit.expected) {
          throw new Error(
            `viewer-assets: expected ${edit.expected} occurrences of "${edit.from}" in ` +
              `${path.basename(file)}, found ${found}. Upstream has changed; re-read it before ` +
              'assuming this patch is still right.',
          )
        }

        return { contents: source.split(edit.from).join(edit.to), loader: 'js' }
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
    return
  }

  generate(version, atlas, states)
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
for (const version of VERSIONS) stageVersion(version)

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'

/**
 * Stages a renderer version while the dev server is running, so a new one costs no restart.
 *
 * **The assets are per version and the list of them was a constant.** `scripts/viewer-assets.mjs`
 * stages an atlas and a block-state file for each version the viewer might be asked to render, and
 * which versions those are came from a list in the script. A fleet pinned to a version nobody had
 * staged got a viewer that refused to start, and the fix was to edit that list and start the dev
 * server again - for a file the renderer would have asked for by name.
 *
 * So the request itself is the trigger. The version is in the URL the browser asks for, the script
 * already takes its list from `OSMIUM_VIEWER_VERSIONS`, and it already skips versions it has
 * staged - so staging one more is that same script with one more name, and the browser waits on the
 * answer rather than on somebody noticing.
 *
 * **Dev only.** A built frontend is static files behind whatever serves them, with no Node to run a
 * staging script; there, the set staged at build time is the set there is.
 */
export function viewerStaging(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const staged = path.resolve(here, '../public/viewer')
  const script = path.resolve(here, '../scripts/viewer-assets.mjs')

  /** One staging run at a time. A second request for the same version waits on the first. */
  let running: Promise<void> | undefined

  return {
    name: 'osmium:viewer-staging',
    apply: 'serve',

    configureServer(server: ViteDevServer) {
      /*
       * Serves the staged assets, because Vite's own static handler will not serve a new one.
       *
       * It indexes `public/` when it starts and does not look again, so a file written there while
       * it runs falls past it to the single-page fallback - which answers **200, with index.html**.
       * Not a 404: the status is fine, the body is a web page, and the renderer's `JSON.parse` on it
       * throws where a missing file would have been obvious. Staging a version therefore appeared to
       * work and then reported the version as unstaged, which is the one thing it was meant to fix.
       *
       * Installed here rather than in the hook Vite calls after its own middlewares, because the
       * fallback is one of those and whatever runs after it never sees the request.
       */
      server.middlewares.use('/viewer', (request, response, next) => {
        const asked = decodeURIComponent(new URL(request.url ?? '/', 'http://viewer').pathname)
        const file = path.join(staged, asked)

        // Nothing outside the staged directory, whatever the path says.
        if (!file.startsWith(staged) || !existsSync(file) || !statSync(file).isFile()) {
          next()
          return
        }

        response.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
        // Rebuilt in place under the same name, so a cached copy is a stale copy. The mesher carries
        // its own stamp in the URL; everything else is settled here.
        response.setHeader('cache-control', 'no-cache')
        createReadStream(file).pipe(response)
      })

      server.middlewares.use('/viewer-staging', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://staging')
        const version = url.searchParams.get('version')?.trim() ?? ''

        const answer = (status: number, body: unknown): void => {
          response.statusCode = status
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(body))
        }

        // Listed before the version check, being the one route that is not about one.
        if (url.pathname === '/list') {
          answer(200, { versions: listStaged(staged) })
          return
        }

        // A version names files on disk, so anything that is not one is refused rather than
        // interpolated into a path.
        if (!/^[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) {
          answer(400, { error: 'not a version' })
          return
        }

        if (url.pathname === '/status') {
          answer(200, { version, staged: isStaged(staged, version) })
          return
        }

        if (url.pathname === '/remove') {
          const gone = discard(staged, version)
          answer(200, { version, freed: gone })
          return
        }

        if (url.pathname !== '/stage') {
          answer(404, { error: 'no such route' })
          return
        }

        if (isStaged(staged, version)) {
          answer(200, { version, staged: true, steps: [] })
          return
        }

        /*
         * Streamed as it happens, because it takes long enough that a spinner alone is a lie.
         *
         * The script narrates itself - every pass prints a `viewer-assets:` line - so those lines
         * are the steps, forwarded as they arrive rather than summarised at the end. Newline
         * delimited JSON rather than server-sent events: this is one request with one answer, and a
         * reader that splits on newlines is the whole client side of it.
         */
        response.statusCode = 200
        response.setHeader('content-type', 'application/x-ndjson')
        response.setHeader('cache-control', 'no-store')

        const say = (event: Record<string, unknown>): void => {
          response.write(`${JSON.stringify(event)}\n`)
        }

        const wanted = [...current(staged), version]
        say({ step: `staging ${version}` })

        running = (running ?? Promise.resolve())
          .catch(() => undefined)
          .then(
            () =>
              new Promise<void>((resolve) => {
                const child = spawn(process.execPath, [script], {
                  env: { ...process.env, OSMIUM_VIEWER_VERSIONS: wanted.join(',') },
                  stdio: ['ignore', 'pipe', 'pipe'],
                })

                let rest = ''
                child.stdout.setEncoding('utf8')
                child.stdout.on('data', (chunk: string) => {
                  rest += chunk
                  const lines = rest.split('\n')
                  rest = lines.pop() ?? ''

                  for (const line of lines) {
                    const said = line.replace(/^viewer-assets:\s*/, '').trim()
                    if (said) say({ step: said })
                  }
                })

                let complaint = ''
                child.stderr.setEncoding('utf8')
                child.stderr.on('data', (chunk: string) => {
                  complaint += chunk
                })

                child.on('close', (code) => {
                  const ok = code === 0 && isStaged(staged, version)

                  if (ok) say({ done: true, version })
                  else say({ error: complaint.trim() || `staging ${version} ended as ${code}` })

                  response.end()
                  resolve()
                })
              }),
          )
      })
    },
  }
}

/** Every artefact staging leaves for one version. Absent ones are simply not counted. */
function filesOf(staged: string, version: string): string[] {
  return [
    path.join(staged, 'textures', `${version}.png`),
    path.join(staged, 'blocksStates', `${version}.json`),
    path.join(staged, 'itemIcons', `${version}.png`),
    path.join(staged, 'itemIcons', `${version}.json`),
    path.join(staged, 'mapColours', `${version}.json`),
  ]
}

/**
 * What is staged and what each version costs.
 *
 * Read off the block-state files rather than the stamp: the stamp says what the *mesher* was built
 * for, which is a list of intentions, and this answers what is actually taking up room.
 */
function listStaged(staged: string): Array<{ version: string; bytes: number }> {
  const states = path.join(staged, 'blocksStates')
  if (!existsSync(states)) return []

  return readdirSync(states)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .map((version) => ({
      version,
      bytes: filesOf(staged, version)
        .filter((file) => existsSync(file))
        .reduce((sum, file) => sum + statSync(file).size, 0),
    }))
    .sort((left, right) => right.bytes - left.bytes)
}

/**
 * Throws one version's assets away, and forgets it was ever built for.
 *
 * The mesher is left alone. It is one bundle for every version and rebuilding it here would cost
 * the minute this is trying to save - but the stamp beside it is rewritten, so the next staging run
 * sees a list it does not match and builds it again without this version in it.
 *
 * Nothing stops a version in use from going: it is staged again on demand, which is the whole point
 * of the plugin, and refusing would mean knowing which browsers are looking at what.
 */
function discard(staged: string, version: string): number {
  let freed = 0

  for (const file of filesOf(staged, version)) {
    if (!existsSync(file)) continue

    freed += statSync(file).size
    rmSync(file, { force: true })
  }

  const stamp = path.join(staged, 'worker.versions.json')
  const left = current(staged).filter((entry) => entry !== version)
  if (existsSync(stamp)) writeFileSync(stamp, JSON.stringify(left))

  return freed
}

/** Enough of a content-type table for the four kinds of file staging leaves behind. */
const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.js': 'text/javascript',
}

/**
 * Whether a version is staged, meaning every file a finished run leaves.
 *
 * **All four, not the two the renderer fetches first.** The passes run in order, so a run that falls
 * over part way still leaves the atlas and the block states behind it - and checking only those
 * reads a failed staging as a finished one, offers the operator nothing, and mounts a viewer whose
 * item icons are missing.
 */
function isStaged(staged: string, version: string): boolean {
  return [
    path.join(staged, 'textures', `${version}.png`),
    path.join(staged, 'blocksStates', `${version}.json`),
    path.join(staged, 'itemIcons', `${version}.png`),
    path.join(staged, 'itemIcons', `${version}.json`),
  ].every((file) => existsSync(file))
}

/**
 * The versions already staged, read off the stamp the script leaves.
 *
 * Passed back in so the run stages one more rather than only the new one: the meshing worker is a
 * single bundle carrying the data for every version in the list, so a run naming one version alone
 * would rebuild it without the others and break every version that used to work.
 */
function current(staged: string): string[] {
  try {
    const listed: unknown = JSON.parse(readFileSync(path.join(staged, 'worker.versions.json'), 'utf8'))
    return Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

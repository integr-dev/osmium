import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'

/**
 * Serves the staged renderer assets, which Vite's own static handler will not do for a new one.
 *
 * It indexes `public/` when it starts and does not look again, so a file written there while it
 * runs falls past it to the single-page fallback - which answers **200, with index.html**. Not a
 * 404: the status is fine, the body is a web page, and the renderer's `JSON.parse` on it throws
 * where a missing file would have been obvious.
 *
 * That is what made staging a version cost a restart. `scripts/viewer-assets.mjs` writes the files
 * happily enough while the server is up; the server simply refused to serve them. With this in
 * place the loop is edit `STAGED_VERSIONS`, run the script, reload the page.
 *
 * **Installed inside `configureServer`** rather than in the hook Vite calls after its own
 * middlewares, because the fallback is one of those and whatever runs after it never sees the
 * request.
 *
 * **Dev only**, and nothing is lost by that: a built frontend copies `public/` into `dist/` and
 * whatever serves that has the files from the start.
 */
export function viewerServing(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const staged = path.resolve(here, '../public/viewer')

  return {
    name: 'osmium:viewer-serving',
    apply: 'serve',

    configureServer(server: ViteDevServer) {
      server.middlewares.use('/viewer', (request, response, next) => {
        const asked = decodeURIComponent(new URL(request.url ?? '/', 'http://viewer').pathname)
        const file = path.join(staged, asked)

        // Nothing outside the staged directory, whatever the path says.
        if (!file.startsWith(staged) || !existsSync(file) || !statSync(file).isFile()) {
          next()
          return
        }

        response.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
        // Rewritten in place under the same name, so a cached copy is a stale copy. The mesher
        // carries its own stamp in the URL; everything else is settled here.
        response.setHeader('cache-control', 'no-cache')
        createReadStream(file).pipe(response)
      })
    },
  }
}

/** Enough of a content-type table for the kinds of file staging leaves behind. */
const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.js': 'text/javascript',
}

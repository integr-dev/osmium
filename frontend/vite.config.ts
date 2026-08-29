import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  define: {
    // prismarine-viewer's world renderer picks its worker path with
    //   `let src = __dirname; if (typeof window !== 'undefined') src = 'worker.js'`
    // - reading the Node global before deciding it is not in Node. Upstream's webpack build defines
    // it away; Vite does not, so the assignment throws before the browser branch is ever reached.
    // The value is immediately overwritten, so what it is does not matter, only that it exists.
    __dirname: '""',
  },
  resolve: {
    alias: {
      // prismarine-viewer's renderer draws nametags through Node's `canvas`, which a browser does
      // not have and does not need. See src/lib/nodeCanvas.ts.
      canvas: fileURLToPath(new URL('./src/lib/nodeCanvas.ts', import.meta.url)),
    },
  },
  server: {
    // Proxying keeps dev same-origin, so the backend needs no CORS configuration yet.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      // The viewer socket. Without `ws` the upgrade is not proxied at all and the request falls
      // through to the SPA's index.html, which a WebSocket reads as a failed handshake.
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
    watch: {
      // Staged renderer assets, tens of megabytes of them and never edited by hand. Watching them
      // is pure cost, and on Windows the watcher fails outright with EBUSY on the 63 MB worker
      // while it is still being written.
      ignored: ['**/public/viewer/**'],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.ts'],
    // An absolute base is required: the client builds a `Request`, which cannot take a relative
    // URL outside a browser. In the app this stays empty so the SPA calls its own origin.
    env: { VITE_API_BASE_URL: 'http://backend.test' },
    alias: [
      {
        find: '/logo.svg',
        replacement: fileURLToPath(new URL('./src/test/asset-stub.ts', import.meta.url)),
      },
    ],
  },
})

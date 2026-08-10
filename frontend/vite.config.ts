import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    // Proxying keeps dev same-origin, so the backend needs no CORS configuration yet.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
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

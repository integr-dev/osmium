/**
 * Stands in for the `canvas` package inside prismarine-viewer's renderer.
 *
 * `viewer/lib/entities.js` reaches for Node's `canvas` to draw a player's nametag, because the same
 * file also runs under upstream's headless renderer. In a browser that dependency is not merely
 * unavailable, it is redundant: `canvas` exists to give Node the drawing surface a browser already
 * has, and the two present the same `getContext('2d')` API. Upstream's own webpack build stubs it
 * out for exactly this reason.
 *
 * Aliased in `vite.config.ts`. Without it the renderer fails to resolve at import, which surfaces
 * as a viewer that connects and immediately disconnects rather than as a missing nametag.
 */
export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Only ever called for a nametag, which is drawn rather than decoded, so there is nothing to load. */
export function loadImage(): Promise<never> {
  return Promise.reject(new Error('loadImage is not supported in the browser build of the viewer'))
}

export default { createCanvas, loadImage }

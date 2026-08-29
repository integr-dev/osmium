/**
 * Globals prismarine-viewer's meshing worker expects, injected by esbuild.
 *
 * The worker is shared with upstream's headless renderer, so it reads `global`, `Buffer` and
 * `process` as though it were in Node. Upstream's webpack build provides them the same way.
 */
import { Buffer } from 'buffer'

const shimmedProcess = { env: { NODE_ENV: 'production' }, platform: 'browser', versions: {}, nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)) }

export { Buffer }
export { shimmedProcess as process }

/**
 * Stands in for files served from `public/`. Vite resolves a root-absolute `src="/logo.svg"` out of
 * the public directory, but under Vitest the same path is read as a filesystem path and fails to
 * load. Aliased in `vite.config.ts`; nothing asserts on the value.
 */
export default '/logo.svg'

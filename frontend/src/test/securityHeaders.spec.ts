import { describe, expect, it } from 'vitest'
// Pulled in as text by Vite rather than read off disk: the app's TypeScript project has no Node
// types, and adding them for one spec would put `process` and `fs` in reach of the whole app.
import config from '../../nginx.conf.template?raw'

/**
 * The deployed security headers, pinned.
 *
 * `nginx.conf.template` is the **only** place these exist, and the Content-Security-Policy in it is
 * what the decision to keep the access token in `localStorage` leans on — see `src/api/token.ts`.
 * A policy that lives in one config file nobody checks is a mitigation on paper, so the shape of it
 * is asserted here rather than trusted.
 *
 * What this cannot check is that the bundle is served by nginx at all. That is a deployment
 * decision, recorded in the README: `dist/` on a static host has no CSP whatsoever, and no signal
 * that it is missing.
 */
const cspLine = config
  .split('\n')
  .find((line) => line.includes('Content-Security-Policy'))

const policy = Object.fromEntries(
  (cspLine?.match(/"([^"]+)"/)?.[1] ?? '')
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...sources] = directive.split(/\s+/)
      return [name, sources]
    }),
)

describe('Content-Security-Policy', () => {
  it('is served on every response, errors included', () => {
    expect(cspLine).toBeDefined()
    expect(cspLine).toContain('always')
  })

  /**
   * The one that matters. The production build emits external, content-hashed JS and needs no
   * inline script, so anything added here would be widening the policy for something else — and
   * this is the directive that decides whether an injected <script> runs.
   */
  it('allows scripts from nowhere but this origin', () => {
    expect(policy['script-src']).toEqual(["'self'"])
  })

  it('never allows eval, under any directive', () => {
    expect(cspLine).not.toContain('unsafe-eval')
  })

  it('locks down the directives that have no legitimate use here', () => {
    expect(policy['default-src']).toEqual(["'self'"])
    expect(policy['object-src']).toEqual(["'none'"])
    expect(policy['base-uri']).toEqual(["'none'"])
    expect(policy['frame-ancestors']).toEqual(["'none'"])
    expect(policy['form-action']).toEqual(["'self'"])
    expect(policy['connect-src']).toEqual(["'self'"])
  })

  /**
   * Player heads are proxied through the backend precisely so this stays off a third-party image
   * host; `blob:` is there because the heads arrive as object URLs, and it can only name a blob
   * this document already created. See `src/lib/avatars.ts`.
   */
  it('allows images from this origin only', () => {
    expect(policy['img-src']).toEqual(["'self'", 'data:', 'blob:'])
  })

  it('names no external host anywhere, and no wildcard', () => {
    const sources = Object.values(policy).flat()
    expect(sources.filter((source) => source.includes('*'))).toEqual([])
    expect(sources.filter((source) => source.includes('//'))).toEqual([])
  })
})

describe('the other security headers', () => {
  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'no-referrer'],
    ['X-Frame-Options', 'DENY'],
    ['Permissions-Policy', 'geolocation=()'],
  ])('%s is set on every response', (header, value) => {
    const line = config.split('\n').find((candidate) => candidate.includes(header))
    expect(line).toContain(value)
    expect(line).toContain('always')
  })
})

/**
 * The nginx trap this whole file turns on: `add_header` inside a `location` **replaces** the
 * inherited set rather than adding to it. One `add_header` in the wrong block silently drops every
 * header above for that path, and the caching and proxy locations are the ones most likely to grow
 * one. Verified against a running container: the policy currently ships on `/`, on `/assets/` and
 * on the SPA fallback alike.
 */
it('sets no header inside a location block, which would drop the inherited set', () => {
  const lines = config.split('\n')
  const firstLocation = lines.findIndex((line) => line.trim().startsWith('location '))

  expect(firstLocation).toBeGreaterThan(-1)
  expect(
    lines.slice(firstLocation).filter((line) => line.trim().startsWith('add_header')),
  ).toEqual([])
})

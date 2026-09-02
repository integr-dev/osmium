import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Palette } from './mapTiles'

/**
 * The palette is one fetch of one generated file, so the only thing worth testing is what happens
 * when that file is not there - which is not the case it looks like. Both deployments answer an
 * unknown path with the app's own HTML and a 200, so "missing" arrives as a *successful* response.
 *
 * The module memoises, deliberately, so each test gets a fresh copy of it rather than the module
 * gaining a reset that only a test would ever call.
 */

function answer(body: string, init: { ok?: boolean; type?: string } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: init.ok ?? true,
        headers: { get: () => init.type ?? 'application/json' },
        json: () => Promise.resolve(JSON.parse(body) as unknown),
      }),
    ),
  )
}

async function subject(): Promise<() => Promise<Palette>> {
  const module = await import('./mapPalette')
  return module.loadPalette
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadPalette', () => {
  it('resolves a block name to its colour', async () => {
    answer('{"grass_block":"7fb238","stone":"707070"}')
    const palette = await (await subject())()

    expect(palette('grass_block')).toEqual([0x7f, 0xb2, 0x38])
    expect(palette('stone')).toEqual([0x70, 0x70, 0x70])
  })

  it('has no colour for a block the table does not carry, which is how air stays air', async () => {
    answer('{"stone":"707070"}')
    const palette = await (await subject())()

    expect(palette('cave_air')).toBeUndefined()
  })

  it('skips an entry that is not a colour rather than failing the whole table', async () => {
    answer('{"stone":"707070","broken":"nope"}')
    const palette = await (await subject())()

    expect(palette('stone')).toEqual([0x70, 0x70, 0x70])
    expect(palette('broken')).toBeUndefined()
  })

  /**
   * The case this exists for. Serving the single-page app in place of the file is a 200 with a body
   * that parses as nothing, and letting it through surfaces as `Unexpected token '<'` - a message
   * about a parser, on a screen about a map.
   */
  it('names the cause when the app is served in place of the table', async () => {
    answer('<!doctype html>', { type: 'text/html' })
    const loadPalette = await subject()

    await expect(loadPalette()).rejects.toThrow(/not being served/)
  })

  it('lets a later attempt try again rather than holding on to the failure', async () => {
    answer('<!doctype html>', { type: 'text/html' })
    const loadPalette = await subject()
    await expect(loadPalette()).rejects.toThrow()

    answer('{"stone":"707070"}')
    expect((await loadPalette())('stone')).toEqual([0x70, 0x70, 0x70])
  })

  it('fetches once however many callers ask while it is in flight', async () => {
    answer('{"stone":"707070"}')
    const loadPalette = await subject()

    const [first, second] = await Promise.all([loadPalette(), loadPalette()])

    expect(first).toBe(second)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
})

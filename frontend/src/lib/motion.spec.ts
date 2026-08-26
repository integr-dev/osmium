import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectiveBinding } from 'vue'
import { prefersReducedMotion, slideName, vFlash } from './motion'

/**
 * The directive is exercised directly rather than through a mounted component. jsdom evaluates no
 * CSS, so mounting would prove only what is asserted here anyway — that the class goes on when the
 * value changed, and stays off otherwise.
 */
function binding(value: unknown, oldValue: unknown): DirectiveBinding<unknown> {
  return { value, oldValue } as DirectiveBinding<unknown>
}

// The hook only ever touches its element and its binding, so the two vnode arguments the real
// signature carries are not supplied.
const flash = vFlash.updated as (el: HTMLElement, binding: DirectiveBinding<unknown>) => void

function update(el: HTMLElement, value: unknown, oldValue: unknown): void {
  flash(el, binding(value, oldValue))
}

function allowMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', () => ({ matches: reduce }))
}

afterEach(() => vi.unstubAllGlobals())

describe('prefersReducedMotion', () => {
  it('assumes reduced motion where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(prefersReducedMotion()).toBe(true)
  })

  it('reports what the media query says', () => {
    allowMotion(false)
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('v-flash', () => {
  it('marks the element when the bound value changed', () => {
    allowMotion(false)
    const el = document.createElement('div')

    update(el, 'ONLINE', 'LINKED')

    expect(el.classList.contains('osmium-flash')).toBe(true)
  })

  it('stays quiet when the element re-rendered but the value did not change', () => {
    allowMotion(false)
    const el = document.createElement('div')

    update(el, 'ONLINE', 'ONLINE')

    // The whole point: a row re-rendering for any other reason is not news.
    expect(el.classList.contains('osmium-flash')).toBe(false)
  })

  it('does nothing at all under prefers-reduced-motion', () => {
    allowMotion(true)
    const el = document.createElement('div')

    update(el, 'ONLINE', 'LINKED')

    expect(el.classList.contains('osmium-flash')).toBe(false)
  })
})

describe('slideName', () => {
  const TABS = ['schematics', 'jobs', 'servers'] as const

  it('goes forward towards the end of the strip', () => {
    expect(slideName(TABS, 'schematics', 'jobs')).toBe('panel-next')
    expect(slideName(TABS, 'schematics', 'servers')).toBe('panel-next')
  })

  it('goes back towards its start', () => {
    expect(slideName(TABS, 'servers', 'schematics')).toBe('panel-prev')
  })

  /** A tab named in a URL this build no longer has. Before everything, so arriving at a real one
   *  reads as moving forward into the strip. */
  it('treats a tab the strip does not have as sitting before it', () => {
    expect(slideName(TABS, 'gone' as (typeof TABS)[number], 'jobs')).toBe('panel-next')
    expect(slideName(TABS, 'jobs', 'gone' as (typeof TABS)[number])).toBe('panel-prev')
  })
})

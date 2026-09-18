/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../i18n'
import {
  resolveTheme,
  setTheme,
  SYSTEM_THEMES,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  themeChoice,
  themeName,
  THEMES,
} from './theme'

// Off the disk rather than imported: the test runner hands a stylesheet import back empty, `?raw` or
// not, and a reader given nothing makes every palette check below pass without looking at anything.
// Relative to the frontend, which is where the test runner is started from.
const stylesheet = readFileSync('src/style.css', 'utf8')
const bootScript = readFileSync('public/theme.js', 'utf8')

/** Every `@plugin "daisyui/theme"` block in the stylesheet, as its name and its declarations. */
function themeBlocks(): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>()
  for (const [, body] of stylesheet.matchAll(/@plugin "daisyui\/theme" \{([^}]*)\}/g)) {
    const declarations = new Map<string, string>()
    for (const line of body!.split(';')) {
      const at = line.indexOf(':')
      if (at === -1) continue
      declarations.set(line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/g, ''))
    }
    blocks.set(declarations.get('name')!, declarations)
  }
  return blocks
}

type Lab = [number, number, number]

/** Oklab from a stylesheet colour: `oklch(L% C H)` or `#rrggbb`. Alpha is ignored. */
function oklab(value: string): Lab {
  const polar = value.match(/^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)/)
  if (polar) {
    const [l, c, h] = [Number(polar[1]) / 100, Number(polar[2]), (Number(polar[3]) * Math.PI) / 180]
    return [l, c * Math.cos(h), c * Math.sin(h)]
  }

  const hex = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!hex) throw new Error(`cannot read colour ${value}`)
  const [r, g, b] = hex.slice(1).map((part) => {
    const channel = parseInt(part, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** WCAG relative luminance, through linear sRGB, clamped to what a screen can show. */
function luminance(value: string): number {
  const [L, a, b] = oklab(value)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (channel: number) => Math.min(1, Math.max(0, channel))
  const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  return 0.2126 * r + 0.7152 * g + 0.0722 * blue
}

function contrast(one: string, other: string): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

describe('the palettes', () => {
  const blocks = themeBlocks()

  /** That the reader above can fail. A parser that finds nothing makes every loop below vacuous. */
  it('finds a block for every theme and nothing else', () => {
    expect([...blocks.keys()].sort()).toEqual(THEMES.map((theme) => theme.id).sort())
  })

  it('declares each one light or dark the way the picker files it', () => {
    for (const theme of THEMES) expect(blocks.get(theme.id)?.get('color-scheme'), theme.id).toBe(theme.scheme)
  })

  it('pairs System with one light and one dark theme', () => {
    expect(THEMES.find((theme) => theme.id === SYSTEM_THEMES.light)?.scheme).toBe('light')
    expect(THEMES.find((theme) => theme.id === SYSTEM_THEMES.dark)?.scheme).toBe('dark')
  })

  /** A token one block leaves out is silently borrowed from whichever theme defines it. */
  it('defines the same tokens in every block', () => {
    const names = (id: string) =>
      [...(blocks.get(id)?.keys() ?? [])].filter((name) => name.startsWith('--')).sort()

    for (const theme of THEMES) expect(names(theme.id), theme.id).toEqual(names('osmium'))
  })

  it('defines every Osmium token the stylesheet uses', () => {
    const used = new Set([...stylesheet.matchAll(/var\((--osmium-[a-z-]+)/g)].map((match) => match[1]!))
    const defined = new Set([...(blocks.get('osmium')?.keys() ?? [])].filter((name) => name.startsWith('--osmium-')))

    for (const token of used) {
      if (token === '--osmium-ease' || token.startsWith('--osmium-place')) continue
      expect(defined, token).toContain(token)
    }
  })

  describe.each(THEMES.map((theme) => theme.id))('%s', (id) => {
    const colour = (token: string) => blocks.get(id)!.get(`--color-${token}`)!

    it('keeps text readable on every ground', () => {
      expect(contrast(colour('base-content'), colour('base-100'))).toBeGreaterThanOrEqual(7)
      expect(contrast(colour('base-content'), colour('base-200'))).toBeGreaterThanOrEqual(7)
      expect(contrast(colour('base-content'), colour('base-300'))).toBeGreaterThanOrEqual(4.5)
    })

    it('keeps the words on a status colour readable', () => {
      for (const status of ['info', 'success', 'warning', 'error']) {
        expect(contrast(colour(`${status}-content`), colour(status)), status).toBeGreaterThanOrEqual(4.5)
      }
    })

    /**
     * A lower floor for the brand colours, and it is Osmium's own: its green carries white at about
     * 2.3, and nothing brand-coloured carries more than a badge's worth of text.
     */
    it('keeps the words on a brand colour legible', () => {
      for (const brand of ['primary', 'secondary', 'accent', 'neutral']) {
        expect(contrast(colour(`${brand}-content`), colour(brand)), brand).toBeGreaterThanOrEqual(2.2)
      }
    })

    /** `text-error` on a log-out button, `text-primary` on a check mark, a soft alert's words. */
    it('keeps the fleet, status and error colours readable as text on the page', () => {
      for (const token of ['primary', 'success', 'warning', 'error']) {
        expect(contrast(colour(token), colour('base-100')), token).toBeGreaterThanOrEqual(3)
      }
    })

    /** The map and the 3D view mark the fleet in one and everybody else in the other. */
    it('never lets the fleet be mistaken for everybody else', () => {
      const [ours, theirs] = [oklab(colour('primary')), oklab(colour('error'))]
      expect(Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2])).toBeGreaterThanOrEqual(0.12)
    })
  })

  it('names every choice in every language', () => {
    for (const [locale, copy] of Object.entries(LOCALES)) {
      for (const choice of THEME_CHOICES) {
        const key = themeName(choice).split('.')
        const found = key.reduce<unknown>((held, part) => (held as Record<string, unknown> | undefined)?.[part], copy)
        expect(found, `${locale} ${choice}`).toEqual(expect.any(String))
      }
    }
  })
})

describe('choosing one', () => {
  let dark = true

  beforeEach(() => {
    dark = true
    localStorage.clear()
    delete document.documentElement.dataset['theme']
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: dark, addEventListener: vi.fn() })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    themeChoice.value = 'system'
  })

  it('reads System as the operating system says', () => {
    expect(resolveTheme('system', true)).toBe('osmium')
    expect(resolveTheme('system', false)).toBe('osmium-light')
    expect(resolveTheme('paper', true)).toBe('paper')
  })

  it('puts a choice on the page and remembers it', () => {
    setTheme('pine')

    expect(document.documentElement.dataset['theme']).toBe('pine')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('pine')
  })

  it('resolves System when it is chosen', () => {
    dark = false
    setTheme('system')

    expect(document.documentElement.dataset['theme']).toBe('osmium-light')
  })

  /** The script that runs before the stylesheet must agree with the app about every stored value. */
  it('opens on the same theme the app would choose, whatever was stored', () => {
    for (const stored of [null, 'system', 'nonsense', ...THEMES.map((theme) => theme.id)]) {
      for (const system of [true, false]) {
        dark = system
        localStorage.clear()
        if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored)
        delete document.documentElement.dataset['theme']

        new Function(bootScript)()

        const choice = THEME_CHOICES.includes(stored as never) ? (stored as (typeof THEME_CHOICES)[number]) : 'system'
        expect(document.documentElement.dataset['theme'], `${stored} on a ${system ? 'dark' : 'light'} system`).toBe(
          resolveTheme(choice, system),
        )
      }
    }
  })
})

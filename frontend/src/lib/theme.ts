import { ref } from 'vue'

/**
 * Which palette the interface is drawn in.
 *
 * **The stylesheet is the source of every colour; this file only picks one.** Each theme is a
 * daisyUI theme block in `src/style.css`, selected by `data-theme` on the root element, and every
 * surface in the application reads its colours from that block's variables. What cannot read a
 * variable - a canvas, a WebGL material, a favicon built as a file - resolves one through
 * {@link themeColour} and listens for {@link onThemeChange}, which is the whole of what "covers
 * everything" takes.
 *
 * `theme.spec.ts` holds the palettes to account: every block defines the same tokens, text is
 * readable on every ground, and the fleet's colour is never mistakable for everybody else's.
 */
export const THEMES = [
  { id: 'osmium', name: 'theme.osmium', scheme: 'dark' },
  { id: 'osmium-light', name: 'theme.osmiumLight', scheme: 'light' },
  { id: 'pine', name: 'theme.pine', scheme: 'dark' },
  { id: 'meadow', name: 'theme.meadow', scheme: 'light' },
  { id: 'graphite', name: 'theme.graphite', scheme: 'dark' },
  { id: 'paper', name: 'theme.paper', scheme: 'light' },
  { id: 'contrast', name: 'theme.contrast', scheme: 'dark' },
  { id: 'chalk', name: 'theme.chalk', scheme: 'light' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

/** A theme, or "whatever the operating system is set to". */
export type ThemeChoice = ThemeId | 'system'

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', ...THEMES.map((theme) => theme.id)]

export const THEME_STORAGE_KEY = 'osmium.theme'

/**
 * What System draws in. Osmium's own pair, so following the operating system changes how light the
 * page is and nothing else about it.
 */
export const SYSTEM_THEMES: Readonly<Record<'light' | 'dark', ThemeId>> = { light: 'osmium-light', dark: 'osmium' }

const DARK = '(prefers-color-scheme: dark)'

export function isThemeChoice(value: string | null): value is ThemeChoice {
  return value !== null && (THEME_CHOICES as readonly string[]).includes(value)
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ThemeId {
  return choice === 'system' ? SYSTEM_THEMES[prefersDark ? 'dark' : 'light'] : choice
}

/** The copy key naming a choice. */
export function themeName(choice: ThemeChoice): string {
  return choice === 'system' ? 'theme.system' : (THEMES.find((theme) => theme.id === choice)?.name ?? 'theme.system')
}

const stored = localStorage.getItem(THEME_STORAGE_KEY)

/** What the operator picked. System until they pick something, like a fresh install of anything. */
export const themeChoice = ref<ThemeChoice>(isThemeChoice(stored) ? stored : 'system')

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK).matches
}

/**
 * Puts the chosen theme on the page.
 *
 * `public/theme.js` has already done this once before the stylesheet painted, so on load this is a
 * no-op; it is what a choice, and the operating system changing its mind, go through afterwards.
 * The attribute is only written when it changes, because every canvas listening for it redraws.
 */
export function applyTheme(): void {
  const id = resolveTheme(themeChoice.value, prefersDark())
  const root = document.documentElement
  if (root.dataset['theme'] !== id) root.dataset['theme'] = id

  // The browser's own chrome on a phone, in the page's ground rather than a colour of its own.
  const chrome = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  const ground = getComputedStyle(root).getPropertyValue('--color-base-100').trim()
  if (chrome && ground) chrome.content = ground
}

/** Remembered per browser, like the language. */
export function setTheme(choice: ThemeChoice): void {
  themeChoice.value = choice
  localStorage.setItem(THEME_STORAGE_KEY, choice)
  applyTheme()
}

let following = false

/** Applies the theme and follows the operating system while the choice is System. Once, at start. */
export function startTheme(): void {
  applyTheme()
  if (following || typeof window.matchMedia !== 'function') return
  following = true
  window.matchMedia(DARK).addEventListener('change', () => {
    if (themeChoice.value === 'system') applyTheme()
  })
}

/**
 * Calls back whenever the page changes theme, for anything drawn where the stylesheet cannot reach.
 * Returns the way to stop.
 */
export function onThemeChange(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/**
 * A theme token as `#rrggbb`, for a consumer that cannot read a CSS variable or parse `oklch()`.
 *
 * Resolved through a one-pixel canvas rather than parsed: the browser is the converter that is
 * certainly right. Falls back when the token is missing, or in a notation the canvas also refuses -
 * an unreadable value leaves `fillStyle` untouched, which a sentinel detects.
 */
export function themeColour(name: string, fallback: string): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!token) return fallback

  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const context = probe.getContext('2d', { willReadFrequently: true })
  if (!context) return fallback

  context.fillStyle = '#000000'
  context.fillStyle = token
  if (context.fillStyle === '#000000') return fallback

  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return '#' + [r, g, b].map((channel) => (channel ?? 0).toString(16).padStart(2, '0')).join('')
}

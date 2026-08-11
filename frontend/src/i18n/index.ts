import { createI18n } from 'vue-i18n'
import { de } from './de'
import { en } from './en'

const STORAGE_KEY = 'osmium.locale'

/**
 * All user-facing copy lives in these files — one place where the product's voice is decided,
 * rather than it accumulating in templates a phrase at a time. English is the source; `Copy` in
 * `en.ts` is the shape the others have to match, so an untranslated key fails the build.
 *
 * `legacy: false` selects the Composition API, so components use `useI18n()`.
 */
export const LOCALES = { en, de }

export type Locale = keyof typeof LOCALES

export function isLocale(value: string | null): value is Locale {
  return value !== null && value in LOCALES
}

// The browser's preference is only a starting point: an explicit choice, once made, outranks it.
const preferred = navigator.languages.map((tag) => tag.split('-')[0]).find(isLocale) ?? 'en'
const stored = localStorage.getItem(STORAGE_KEY)
const initial: Locale = isLocale(stored) ? stored : preferred

export const i18n = createI18n({
  legacy: false,
  locale: initial,
  fallbackLocale: 'en',
  messages: LOCALES,
})

/**
 * Switching is instant — every component reads its copy through `useI18n()`, so nothing reloads.
 * `<html lang>` moves with it, which is what a screen reader picks its pronunciation from.
 */
export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale
  localStorage.setItem(STORAGE_KEY, locale)
  document.documentElement.lang = locale
}

document.documentElement.lang = initial

/**
 * For code that is not a component — stores, presentation maps, route metadata. Components should
 * use `useI18n()` so they re-render when the locale changes.
 */
export const t = i18n.global.t

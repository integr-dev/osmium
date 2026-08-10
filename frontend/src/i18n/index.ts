import { createI18n } from 'vue-i18n'
import { en } from './en'

/**
 * All user-facing copy lives in `en.ts`. One locale for now — the point is not translation but
 * having a single place where the product's voice is decided, rather than it accumulating in
 * templates a phrase at a time.
 *
 * `legacy: false` selects the Composition API, so components use `useI18n()`.
 */
export const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en },
})

/**
 * For code that is not a component — stores, presentation maps, route metadata. Components should
 * use `useI18n()` so they re-render when the locale changes.
 */
export const t = i18n.global.t

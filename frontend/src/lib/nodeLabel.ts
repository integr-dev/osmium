import { i18n, isLocale, LOCALES } from '../i18n'

/**
 * Human-readable name for a permission node.
 *
 * Indexed straight out of the copy files rather than through `t()`, because vue-i18n reads a dot in
 * a key as a path separator: `t('permission.fleet.chat')` looks for `permission → fleet → chat` and
 * silently falls back, since the key is the flat string `'fleet.chat'`. Node ids contain dots by
 * design, so the lookup has to bypass path resolution — which means picking the locale by hand too.
 * Reading the locale ref here is what makes a caller re-render when the language changes.
 *
 * Presentational only - the raw node string stays the source of truth and is what the API
 * authorizes against. An unmapped node falls back to its own id, so a node added on the backend
 * still renders rather than disappearing.
 */
export function nodeLabel(node: string): string {
  const locale = i18n.global.locale.value
  const labels: Record<string, string> = LOCALES[isLocale(locale) ? locale : 'en'].permission
  return labels[node] ?? node
}

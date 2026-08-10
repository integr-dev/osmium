import { en } from '../i18n/en'

/**
 * Human-readable name for a permission node.
 *
 * Indexed straight out of the copy file rather than through `t()`, because vue-i18n reads a dot in
 * a key as a path separator: `t('permission.fleet.chat')` looks for `permission → fleet → chat` and
 * silently falls back, since the key is the flat string `'fleet.chat'`. Node ids contain dots by
 * design, so the lookup has to bypass path resolution.
 *
 * Presentational only - the raw node string stays the source of truth and is what the API
 * authorizes against. An unmapped node falls back to its own id, so a node added on the backend
 * still renders rather than disappearing.
 */
const LABELS: Record<string, string> = en.permission

export function nodeLabel(node: string): string {
  return LABELS[node] ?? node
}

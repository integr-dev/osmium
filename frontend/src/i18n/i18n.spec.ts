import { describe, expect, it } from 'vitest'
import { i18n, t } from '.'
import { de } from './de'
import { en } from './en'
import { nodeLabel } from '../lib/nodeLabel'

/**
 * A missing key resolves to the key itself, so a typo shows up as `agents.setUp` on screen rather
 * than as an error. These check the lookups that are built from a variable at runtime — the ones a
 * type-check cannot catch.
 */
const resolves = (key: string) => t(key) !== key

describe('copy lookups', () => {
  it('resolves every agent state', () => {
    for (const state of Object.keys(en.agentState)) {
      expect(resolves(`agentState.${state}`), state).toBe(true)
    }
  })

  it('resolves every audit action', () => {
    for (const action of Object.keys(en.auditAction)) {
      expect(resolves(`auditAction.${action}`), action).toBe(true)
    }
  })

  /**
   * Node ids contain dots, which vue-i18n reads as a path separator — `permission.chat.read` looks
   * for `permission → fleet → chat` and falls back silently. That is why `nodeLabel` indexes the
   * copy directly instead of going through `t()`, and this is the test that keeps it that way.
   */
  it('names every permission node without hitting path resolution', () => {
    for (const node of Object.keys(en.permission)) {
      expect(nodeLabel(node), node).not.toBe(node)
      expect(t(`permission.${node}`), node).toBe(`permission.${node}`)
    }
  })

  it('interpolates named parameters', () => {
    expect(t('agents.setUpTitle', { name: 'Mason_04' })).toContain('Mason_04')
    expect(t('hosts.removeTitle', { name: 'eu-1' })).toContain('eu-1')
  })

  it('has both locales registered', () => {
    expect([...i18n.global.availableLocales].sort()).toEqual(['de', 'en'])
  })
})

/** Every string in a copy file, keyed by its dotted path. */
function flatten(copy: object, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(copy)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') flat[path] = value
    else Object.assign(flat, flatten(value, path))
  }
  return flat
}

const placeholders = (phrase: string) => (phrase.match(/\{\w+\}/g) ?? []).sort()

/**
 * `Copy` already makes a missing key a compile error, so these cover what the type cannot see: that
 * the translation carries the same interpolation, and that the key sets really are identical rather
 * than one of them being widened by an `as` somewhere.
 */
describe('translations', () => {
  const english = flatten(en)
  const german = flatten(de)

  it('translates every key English has, and no others', () => {
    expect(Object.keys(german).sort()).toEqual(Object.keys(english).sort())
  })

  // A dropped {name} does not fail — vue-i18n renders the rest of the phrase and the value with it.
  it('keeps every interpolation placeholder', () => {
    for (const [key, phrase] of Object.entries(english)) {
      expect(placeholders(german[key]), key).toEqual(placeholders(phrase))
    }
  })

  // A translation with one form where English has two silently loses the singular.
  it('keeps the same number of plural forms', () => {
    for (const [key, phrase] of Object.entries(english)) {
      expect(german[key].split('|').length, key).toBe(phrase.split('|').length)
    }
  })

  it('reads the copy of whichever locale is selected', () => {
    try {
      i18n.global.locale.value = 'de'
      expect(t('nav.logOut')).toBe(de.nav.logOut)
    } finally {
      i18n.global.locale.value = 'en'
    }
    expect(t('nav.logOut')).toBe(en.nav.logOut)
  })
})

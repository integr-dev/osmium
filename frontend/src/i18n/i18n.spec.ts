import { describe, expect, it } from 'vitest'
import { i18n, t } from '.'
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

  it('resolves every login method', () => {
    for (const id of Object.keys(en.loginMethod)) {
      expect(resolves(`loginMethod.${id}.label`), id).toBe(true)
      expect(resolves(`loginMethod.${id}.description`), id).toBe(true)
    }
  })

  /**
   * Node ids contain dots, which vue-i18n reads as a path separator — `permission.fleet.chat` looks
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

  it('has one locale registered', () => {
    expect(i18n.global.availableLocales).toEqual(['en'])
  })
})
